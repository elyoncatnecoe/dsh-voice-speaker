# dsh-voice-speaker

DeepSeek Harness（DSH）语音朗读插件：用 DeepSeek 官方 TTS 朗读助手回复，内置轻量变声。

> 输入框旁一个喇叭读最新回复；每条助手回复的动作条里也有一个喇叭，任意一条（含历史消息）都能单独朗读。播放走**流式 PCM**：边收边播、首帧即出声、随时可停。

## 功能

- **一键朗读**：点喇叭读最新一条助手回复；每条消息旁可单独朗读/停止。
- **音色档位**（可视化面板）：
  - `海星`（stella，官方女声原声）
  - `暗潮`（tide，官方男声原声）
  - `正太`（海星 +0.5 半音）
  - `萝莉`（海星 +2 半音）
  - `中性`（海星 −3 半音）
  - `少年`（暗潮 +3 半音）
  - `大叔`（暗潮 −2 半音）
- **自由微调**：±6 半音滑块（仅影响播放，不改原音频）。
- **只读正文**：只朗读助手回复正文（`kind:'text'` 块），跳过思考/推理与工具调用。
- **可视开关**：面板可关闭；关闭后输入框旁只留一个 ▾ 设置入口，不丢失。也可在插件管理里整体停用。
- **主题跟随**：使用 DSH 主题变量（`--dsw-alias-*`），深浅色自动适配。

## 安装

这是一个 DSH **bundle 插件**，需要装在某个 profile（如 `desktop`）里。

方式一（本地目录）：把本仓库放到任意目录，然后在 DSH 的 **Plugins → Add plugin** 选择该目录安装。

方式二（Agent 工具）：

```
plugin_manager(action="install_bundle", target="<本仓库绝对路径>")
```

安装后重启/刷新 DSH，输入框旁会出现喇叭；在 **Plugins** 里可随时停用。

## 配置

- 需要一个 DeepSeek API Key，用于调用官方 TTS（`https://api.deepseek.com/v1/tools/tts`）。
- Key 的读取顺序：插件 `config.apiKey` → 环境变量 `DEEPSEEK_API_KEY` → `$DSH_HOME/.credentials.yaml` 里的 `DEEPSEEK_API_KEY`。
- 密钥只在**本机 Host 进程**内读取，不经浏览器。

## 计费

- 朗读按字符计费：汉字算 2 字符，1 万计费字符 3 元（限时 5 折 1.5 元）。
- **变声与播放不产生任何 API 调用、不额外计费**；变调在本机浏览器完成，不落文件。

## 结构

```
package.json          # bundle 清单（dsh.bundle / dsh.client）
cordis.patch.yml      # 插入 voice-speaker 行
index.js              # Host：POST /dsh-voice/speak 流式转发官方 TTS（format=pcm）
client.js             # Client：输入框喇叭 + 每条消息喇叭 + 变声面板 + 流式播放
locale/zh.json|en.json# 插件显示名称与描述
icon.svg              # 图标
docs/DETAIL.md        # 插件详情页
```

## 已知限制

- 官方只有 `海星 / 暗潮` 两个音色，其余为音高变调模拟，极端参数会失真（建议 ±6 半音内）。
- 变调会带共振峰一起移动，是"同一个声音变高变低"，不是真正换人声。
- 单条正文超过 5000 字符会被拒读，需分段。

## License

[MIT](./LICENSE) © 2026 猫伊cat
