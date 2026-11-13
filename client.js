window.__ModuleLoader__.load({
  id: '@local/dsh-voice-speaker',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const STORE_KEY = 'dsh.voice-speaker.v1'

    // voice presets: 海星/暗潮 are the two official voices; others are pitch variants
    const PRESETS = [
      { id: 'stella', label: '海星', voice: 'stella', semitones: 0 },
      { id: 'tide', label: '暗潮', voice: 'tide', semitones: 0 },
      { id: 'shota', label: '正太', voice: 'stella', semitones: 0.5 },
      { id: 'loli', label: '萝莉', voice: 'stella', semitones: 2 },
      { id: 'neutral', label: '中性', voice: 'stella', semitones: -3 },
      { id: 'boy', label: '少年', voice: 'tide', semitones: 3 },
      { id: 'uncle', label: '大叔', voice: 'tide', semitones: -2 },
    ]
    const DEFAULTS = { enabled: true, presetId: 'stella', voice: 'stella', semitones: 0 }

    function getSettings() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (raw) return Object.assign({}, DEFAULTS, JSON.parse(raw))
      } catch (e) { /* ignore */ }
      return Object.assign({}, DEFAULTS)
    }
    function saveSettings(s) {
      try { window.localStorage.setItem(STORE_KEY, JSON.stringify(s)) } catch (e) { /* ignore */ }
    }
    let settingsCache = getSettings()
    const settingsListeners = new Set()
    function setSettingsGlobal(s) {
      settingsCache = s
      saveSettings(s)
      for (const fn of settingsListeners) { try { fn(s) } catch (e) { /* ignore */ } }
    }
    function useSettings() {
      const [, force] = useState(0)
      useEffect(() => {
        const fn = () => force((x) => x + 1)
        settingsListeners.add(fn)
        return () => { settingsListeners.delete(fn) }
      }, [])
      return settingsCache
    }

    // ---------- message text (block.kind is 'text' | 'reasoning' | 'image' | 'tool-call' | 'other') ----------
    function blocksText(blocks) {
      if (!Array.isArray(blocks)) return ''
      const parts = []
      for (const b of blocks) {
        if (b && b.kind === 'text' && typeof b.text === 'string' && b.text) parts.push(b.text)
      }
      return parts.join('\n').trim()
    }
    function legacyNodes(snap) {
      if (!snap) return []
      if (snap.legacy && Array.isArray(snap.legacy.nodes)) return snap.legacy.nodes
      if (snap.nodes && typeof snap.nodes.values === 'function') return snap.nodes.values()
      return []
    }
    function latestAssistantText(snap) {
      const nodes = legacyNodes(snap)
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]
        if (n && n.kind === 'assistant') { const t = blocksText(n.blocks); if (t) return t }
      }
      if (snap && snap.legacy && snap.legacy.partial) {
        const t = blocksText(snap.legacy.partial.blocks); if (t) return t
      }
      return ''
    }
    function assistantTextById(snap, messageId) {
      const nodes = legacyNodes(snap)
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]
        if (n && n.kind === 'assistant' && n.messageId === messageId) return blocksText(n.blocks)
      }
      return ''
    }

    // ---------- pitch shift (WSOLA + resample), pure JS ----------
    function wsolaStretch(x, S) {
      const N = 1024, overlap = N >> 1, tol = overlap >> 1
      const corrLen = Math.min(256, overlap)
      const Hs = overlap, Ha = Hs / S
      const win = new Float32Array(N)
      for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))
      const pad = tol + N, len = x.length
      const xp = new Float32Array(len + 2 * pad); xp.set(x, pad)
      const outLen = Math.round(len * S)
      const out = new Float32Array(outLen + N + Hs), norm = new Float32Array(out.length)
      let prevTail = null
      const nframes = Math.ceil(outLen / Hs) + 1
      for (let i = 0; i < nframes; i++) {
        const ideal = pad + i * Ha
        let off = Math.round(ideal)
        if (prevTail !== null) {
          const lo = Math.max(0, off - tol), hi = Math.min(xp.length - N, off + tol)
          if (hi >= lo) {
            let best = -Infinity, bestOff = lo
            for (let o = lo; o <= hi; o++) {
              let dot = 0, e = 0
              for (let j = 0; j < corrLen; j++) { const v = xp[o + j]; dot += v * prevTail[j]; e += v * v }
              const ncc = dot / Math.sqrt(e + 1e-9)
              if (ncc > best) { best = ncc; bestOff = o }
            }
            off = bestOff
          }
        }
        const opos = i * Hs
        for (let j = 0; j < N; j++) { const idx = off + j; const v = idx < xp.length ? xp[idx] : 0; out[opos + j] += v * win[j]; norm[opos + j] += win[j] }
        const tail = new Float32Array(corrLen)
        for (let j = 0; j < corrLen; j++) { const idx = off + overlap + j; tail[j] = idx < xp.length ? xp[idx] : 0 }
        prevTail = tail
      }
      const res = new Float32Array(outLen)
      for (let i = 0; i < outLen; i++) { const n = norm[i]; res[i] = n > 1e-8 ? out[i] / n : 0 }
      return res
    }
    function resampleTo(x, targetLen) {
      const y = new Float32Array(targetLen)
      const ratio = (x.length - 1) / Math.max(1, targetLen - 1)
      for (let i = 0; i < targetLen; i++) {
        const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, x.length - 1), f = pos - i0
        y[i] = x[i0] * (1 - f) + x[i1] * f
      }
      return y
    }
    function pitchShiftFloat(x, semitones) {
      if (!semitones) return x
      const r = Math.pow(2, semitones / 12)
      return resampleTo(wsolaStretch(x, r), x.length)
    }

    // ---------- streaming PCM player (chat-demo style) ----------
    const START_DELAY = 0.1
    const BLOCK = 8192 // samples; used only when pitch shifting (≈340ms)
    let audioCtx = null
    let engine = null // { ctrl, sources:Set, nextTime, done, id }

    let playState = { id: null, status: 'idle' }
    const playListeners = new Set()
    function setPlay(id, status) {
      playState = { id, status }
      for (const fn of playListeners) { try { fn(playState) } catch (e) { /* ignore */ } }
    }
    function usePlay() {
      const [, force] = useState(0)
      useEffect(() => {
        const fn = () => force((x) => x + 1)
        playListeners.add(fn)
        return () => { playListeners.delete(fn) }
      }, [])
      return playState
    }

    function ensureCtx() {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext
        try { audioCtx = new AC({ sampleRate: 24000 }) } catch (e) { audioCtx = new AC() }
      }
      return audioCtx
    }
    function stopEngine() {
      if (engine) {
        try { engine.ctrl && engine.ctrl.abort() } catch (e) { /* ignore */ }
        for (const s of engine.sources) { try { s.onended = null; s.stop() } catch (e) { /* ignore */ } }
        engine = null
      }
      setPlay(null, 'idle')
    }
    function pcmToFloat(bytes, sampleCount) {
      const out = new Float32Array(sampleCount)
      const dv = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2)
      for (let i = 0; i < sampleCount; i++) out[i] = dv.getInt16(i * 2, true) / 32768
      return out
    }

    async function playPcmStream(text, settings, id) {
      stopEngine()
      const ctx = ensureCtx()
      try { await ctx.resume() } catch (e) { /* ignore */ }
      const st = Number(settings.semitones) || 0
      const ctrl = new AbortController()
      const E = { ctrl, sources: new Set(), nextTime: 0, done: false, id }
      engine = E
      setPlay(id, 'loading')
      try {
        const resp = await fetch('/dsh-voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice: settings.voice || 'stella' }),
          signal: ctrl.signal,
        })
        if (!resp.ok) {
          let m = 'HTTP ' + resp.status
          try { const j = await resp.json(); if (j && j.error) m = j.error } catch (e) { /* ignore */ }
          throw new Error(m)
        }
        const reader = resp.body.getReader()
        let rest = new Uint8Array(0)
        let acc = new Float32Array(0)
        const schedule = (samples) => {
          if (!samples || !samples.length || engine !== E) return
          const buf = ctx.createBuffer(1, samples.length, 24000)
          buf.copyToChannel(samples, 0)
          const src = ctx.createBufferSource()
          src.buffer = buf
          src.connect(ctx.destination)
          const now = ctx.currentTime
          if (E.nextTime < now + START_DELAY) E.nextTime = now + START_DELAY
          try { src.start(E.nextTime) } catch (e) { /* ignore */ }
          E.nextTime += buf.duration
          E.sources.add(src)
          if (playState.status !== 'playing') setPlay(id, 'playing')
          src.onended = () => {
            E.sources.delete(src)
            if (engine === E && E.done && E.sources.size === 0) setPlay(null, 'idle')
          }
        }
        for (;;) {
          const r = await reader.read()
          if (r.done) break
          const value = r.value
          let bytes
          if (rest.length) { bytes = new Uint8Array(rest.length + value.length); bytes.set(rest); bytes.set(value, rest.length) } else { bytes = value }
          const ns = bytes.length >> 1
          const samples = pcmToFloat(bytes, ns)
          rest = bytes.slice(ns * 2)
          if (st) {
            const merged = new Float32Array(acc.length + samples.length)
            merged.set(acc); merged.set(samples, acc.length); acc = merged
            while (acc.length >= BLOCK) { const blk = acc.slice(0, BLOCK); acc = acc.slice(BLOCK); schedule(pitchShiftFloat(blk, st)) }
          } else {
            schedule(samples)
          }
        }
        if (st && acc.length) { schedule(pitchShiftFloat(acc, st)); acc = new Float32Array(0) }
        E.done = true
        if (engine === E && E.sources.size === 0) setPlay(null, 'idle')
      } catch (e) {
        if (!ctrl.signal.aborted) { setPlay(null, 'idle'); throw e }
      }
    }

    // ---------- shared UI ----------
    const CSS = ''
      + '.vspk-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:6px;cursor:pointer;padding:0;line-height:1;}'
      + '.vspk-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}'
      + '.vspk-iconbtn.on{color:var(--dsw-alias-state-business-primary);}'
      + '.vspk-chip{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:999px;padding:5px 10px;cursor:pointer;font-size:12px;transition:background .12s;}'
      + '.vspk-chip:hover{background:var(--dsw-alias-interactive-bg-hover);}'
      + '.vspk-chip.on{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-color);}'
      + '.vspk-panel{position:absolute;bottom:calc(100% + 8px);left:0;z-index:4000;width:272px;padding:12px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.18));color:var(--dsw-alias-label-primary);font-size:12px;}'
      + '.vspk-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}'
      + '.vspk-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}'
      + '.vspk-label{font-size:11px;color:var(--dsw-alias-label-tertiary);}'
      + '.vspk-status{margin-top:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all;}'

    function SpeakerIcon(props) {
      const size = props.size || 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M3.2 6.1h2.1l3-2.6v9l-3-2.6H3.2z', fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M10.4 5.7c1.1 1.1 1.1 3.5 0 4.6' }),
        h('path', { d: 'M12.3 4c2 2 2 6 0 8' }),
      )
    }
    function StopIcon(props) {
      const size = props.size || 16
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true },
        h('rect', { x: 5, y: 5, width: 6, height: 6, rx: 1.2, fill: 'currentColor' }))
    }

    // ---------- composer dock control ----------
    function VoiceSpeakerDock(props) {
      const settings = useSettings()
      const [open, setOpen] = useState(false)
      const [status, setStatus] = useState('')
      const play = usePlay()

      let snap
      if (typeof props.useChat === 'function') { try { snap = props.useChat((s) => s) } catch (e) { snap = undefined } }

      const update = useCallback((patch) => setSettingsGlobal(Object.assign({}, settingsCache, patch)), [])
      const applyPreset = useCallback((p) => update({ presetId: p.id, voice: p.voice, semitones: p.semitones }), [update])

      const mine = play.id === '__latest__'
      const busy = mine && play.status !== 'idle'
      const onSpeak = useCallback(() => {
        if (busy) { stopEngine(); setStatus(''); return }
        const text = latestAssistantText(snap)
        if (!text) { setStatus('没有找到可朗读的助手回复'); return }
        setStatus('')
        playPcmStream(text, settings, '__latest__').catch((e) => setStatus('失败：' + String((e && e.message) || e)))
      }, [busy, snap, settings])

      // when disabled: keep only a tiny gear so the settings entry never disappears
      if (!settings.enabled) {
        return h('div', { style: { position: 'relative', display: 'inline-flex' } },
          h('style', null, CSS),
          h('button', {
            type: 'button', className: 'vspk-iconbtn', title: '语音朗读（已关闭，点击开启）',
            'aria-label': 'Voice settings', onClick: () => setOpen((v) => !v),
          }, h('span', { style: { fontSize: 12 } }, '▾')),
          open ? renderPanel() : null,
        )
      }

      function renderPanel() {
        return h('div', { className: 'vspk-panel' },
          h('div', { className: 'vspk-row' },
            h('strong', { style: { fontSize: 13 } }, '语音朗读'),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)' } },
              h('input', { type: 'checkbox', checked: !!settings.enabled, onChange: (e) => update({ enabled: e.target.checked }) }),
              '启用',
            ),
          ),
          h('div', { className: 'vspk-label', style: { marginTop: 8 } }, '音色（海星 / 暗潮 = 官方原声，其余为变调）'),
          h('div', { className: 'vspk-chips' },
            PRESETS.map((p) => h('button', {
              key: p.id, type: 'button', className: 'vspk-chip' + (settings.presetId === p.id ? ' on' : ''),
              onClick: () => applyPreset(p),
            }, p.label)),
          ),
          h('div', { className: 'vspk-row', style: { marginTop: 12 } },
            h('span', { className: 'vspk-label' }, '自由微调'),
            h('span', { className: 'vspk-label' }, (settings.semitones > 0 ? '+' : '') + settings.semitones + ' 半音'),
          ),
          h('input', {
            type: 'range', min: -6, max: 6, step: 0.5, value: settings.semitones, style: { width: '100%' },
            onChange: (e) => update({ semitones: Number(e.target.value), presetId: 'custom' }),
          }),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('button', { type: 'button', className: 'vspk-chip on', style: { flex: 1, padding: '6px 10px' }, onClick: onSpeak },
              busy ? (play.status === 'loading' ? '生成中…' : '停止') : '朗读最新回复'),
          ),
          status ? h('div', { className: 'vspk-status' }, status) : null,
        )
      }

      return h('div', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 2 } },
        h('style', null, CSS),
        h('button', {
          type: 'button', className: 'vspk-iconbtn' + (busy ? ' on' : ''),
          title: busy ? '点击停止' : '朗读最新回复', 'aria-label': 'Voice speaker', onClick: onSpeak,
        }, busy ? h(StopIcon, { size: 15 }) : h(SpeakerIcon, { size: 17 })),
        h('button', {
          type: 'button', className: 'vspk-iconbtn', title: '音色设置', 'aria-label': 'Voice settings',
          style: { width: 16, fontSize: 10 }, onClick: () => setOpen((v) => !v),
        }, '▾'),
        open ? renderPanel() : null,
      )
    }

    // ---------- per-message action (every finalized assistant message) ----------
    function VoiceMessageButton(props) {
      const play = usePlay()
      const settings = useSettings()
      const messageId = props.messageId
      let snap
      if (typeof props.useChat === 'function') { try { snap = props.useChat((s) => s) } catch (e) { snap = undefined } }
      if (!settings.enabled) return null
      const mine = play.id === messageId
      const busy = mine && play.status !== 'idle'
      const onClick = useCallback(() => {
        if (busy) { stopEngine(); return }
        const text = assistantTextById(snap, messageId)
        if (text) playPcmStream(text, settings, messageId).catch(() => {})
      }, [busy, snap, messageId, settings])
      return h(React.Fragment, null,
        h('style', null, CSS),
        h('button', {
          type: 'button', className: 'vspk-iconbtn' + (busy ? ' on' : ''),
          title: busy ? '停止朗读' : '朗读这条回复', 'aria-label': 'Read this message aloud', onClick,
        }, busy ? h(StopIcon, { size: 15 }) : h(SpeakerIcon, { size: 16 })))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'voice-speaker', order: 8,
        }, VoiceSpeakerDock))
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions', id: 'voice-speaker-action', order: 20,
        }, VoiceMessageButton))
      },
    }
  },
})
