/**
 * Host half of dsh-voice-speaker.
 * POST /dsh-voice/speak  { text, voice:'stella'|'tide' } -> 200 audio/L16 raw PCM (24kHz,16-bit,mono), streamed.
 * GET  /dsh-voice/ping   -> 'ok'
 * The upstream DeepSeek TTS is requested with format=pcm and its body is piped
 * straight through, so the browser starts playing on the first chunk.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TTS_URL = 'https://api.deepseek.com/v1/tools/tts'
const VOICES = new Set(['stella', 'tide'])
const MAX_CHARS = 5000

function readKeyFromDisk() {
  try {
    const p = join(homedir(), '.dsh', '.credentials.yaml')
    const txt = readFileSync(p, 'utf8')
    const m = txt.match(/DEEPSEEK_API_KEY:\s*(\S+)/)
    if (m) return m[1].replace(/^["']|["']$/g, '')
  } catch { /* ignore */ }
  return ''
}
function resolveKey(config) {
  return (config && config.apiKey) || process.env.DEEPSEEK_API_KEY || readKeyFromDisk() || ''
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 4_000_000) { reject(new Error('body too large')); req.destroy() }
    })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}
function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', String(body.length))
  res.end(body)
}

export const inject = ['webServer']

export function apply(ctx, config) {
  const cfg = config || {}
  const baseUrl = cfg.baseUrl || TTS_URL

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-voice/ping',
      handler: (req, res) => {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end('ok')
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-voice/speak',
      handler: async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return }
        const ac = new AbortController()
        res.on('close', () => { if (!res.writableEnded) { try { ac.abort() } catch { /* ignore */ } } })
        try {
          const data = await readJsonBody(req)
          const text = String(data.text || '').trim()
          const voice = VOICES.has(data.voice) ? data.voice : 'stella'
          if (!text) { sendJson(res, 400, { error: 'empty text' }); return }
          if (text.length > MAX_CHARS) { sendJson(res, 413, { error: 'text too long (max ' + MAX_CHARS + ')' }); return }
          const key = resolveKey(cfg)
          if (!key) { sendJson(res, 500, { error: 'DEEPSEEK_API_KEY not found' }); return }

          const upstream = await fetch(baseUrl, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice_id: voice, format: 'pcm' }),
            signal: ac.signal,
          })
          if (!upstream.ok) {
            let msg = 'TTS HTTP ' + upstream.status
            try { const t = await upstream.text(); if (t) msg += ': ' + t.slice(0, 300) } catch { /* ignore */ }
            sendJson(res, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502, { error: msg })
            return
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'audio/L16;rate=24000;channels=1')
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader('X-Audio-Sample-Rate', '24000')
          if (!upstream.body) { res.end(); return }
          for await (const chunk of upstream.body) {
            if (res.writableEnded || ac.signal.aborted) break
            res.write(Buffer.from(chunk))
          }
          res.end()
        } catch (e) {
          if (!res.headersSent) {
            const code = e && e.status && e.status >= 400 && e.status < 600 ? e.status : 502
            sendJson(res, code, { error: String((e && e.message) || e) })
          } else {
            try { res.end() } catch { /* ignore */ }
          }
        }
      },
    }),
  )
}
