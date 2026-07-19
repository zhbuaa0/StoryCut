# StoryCut

[English](README.md) | [简体中文](README.zh-CN.md)

**AI 提出建议，创作者做出决定。**

StoryCut 是一款面向口播和 Vlog 视频的、可解释且有人参与决策的粗剪原型。它能把转录文本转换为可审阅的 `KEEP`、`CUT`、`MOVE` 和 `B-ROLL` 建议，为每项决定提供理由，并导出可编辑的时间线 JSON。

本仓库包含为 OpenAI Build Week **Work and Productivity** 类别开发的首个公开安全 MVP。

## 已实现功能

**v0.1（粘贴转录稿路径）**

- 粘贴普通文本、SRT 或 VTT 转录稿
- 无需 API Key，使用确定性的本地演示分析器
- 可选：通过服务端 OpenAI Responses API 使用 GPT-5.6
- 按决策类型筛选，并接受或拒绝每条建议
- 将审阅后的决定导出为时间线 JSON
- 适合演示的响应式界面

**v0.2（本地媒体路径）**

- 拖入 mp4 / mov / m4a / wav / mp3，文件不会离开本机
- 服务端通过 `tools/transcribe.py` 调用 Apple Silicon 上的 **MLX Whisper**，通过 SSE 把进度和最终带时间码的转录实时推送给浏览器
- 词级时间戳贯穿转写、对齐和既有的决策引擎
- 媒体路径产出的决策和粘贴路径共用同一个审阅界面

StoryCut v0.2 仍不上传源媒体、不渲染最终成片，也不持久化项目数据。

## 本地运行

环境要求：Node.js 20 或更高。v0.2 媒体路径还需要：Apple Silicon 上的 macOS、MLX Whisper、ffmpeg / ffprobe（Homebrew）。

```bash
npm start
```

打开 <http://127.0.0.1:4173>。

- **粘贴路径**（人人可跑）：点 **Load safe demo**，再点 **Analyze story**。
- **媒体路径**（Apple Silicon）：把 mp4 / mov / m4a / wav / mp3 拖到上传区，等转写完毕，同一个审阅界面会展示带时间码的决策。

Node 服务端无需安装任何第三方依赖；媒体路径依赖 MLX Whisper 与 ffmpeg 已加入 `PATH`。

## 可选的 GPT-5.6 模式

API 凭证必须保留在服务端。请勿把 Key 放入 `public/`、源代码、截图或 Git 提交中。

```bash
export OPENAI_API_KEY="your-key"
export OPENAI_MODEL="gpt-5.6-terra"
npm start
```

未配置 Key 时，应用仍可完整使用本地演示模式。粘贴路径（`/api/analyze`）和媒体路径（`/api/analyze-transcript`）都遵循这个开关。

## v0.2 的环境变量

| 变量 | 用途 | 默认值 |
|---|---|---|
| `STORYCUT_MAX_UPLOAD_BYTES` | `/api/upload` 请求体上限 | `524288000`（500 MB） |
| `STORYCUT_WHISPER_MODEL` | `tools/transcribe.py` 使用的 MLX Whisper 仓库 | `mlx-community/whisper-small-mlx` |
| `STORYCUT_WORK_DIR` | 上传媒体与转录缓存的存放位置 | `<repo>/.work` |
| `STORYCUT_SKIP_TRANSCRIBE_TESTS=1` | 跳过端到端转写测试（例如 CI 里没缓存模型时） | 未设置 |

## 隐私与安全

- 源媒体仅上传到 `127.0.0.1`，字节流不会离开本机。
- 转录文本仅在内存中处理，不写入磁盘。
- API Key 只从服务端环境变量读取，绝不会返回浏览器。
- 原始媒体、转录稿、密钥、环境配置文件和常见私钥格式均已加入 Git 忽略规则。已提交的合成音频 fixture（`tests/fixtures/short.mp3`）在 `.gitignore` 与 `scripts/privacy-check.mjs` 中以白名单形式存在；任何新增 fixture 都需要按 `HANDOFF.md` 中的要求走安全审核。
- 分析请求限制为 200 KB、上传请求限制为 500 MB（默认）。
- 服务默认只监听 `127.0.0.1`，并发送严格的浏览器安全响应头。
- 每次公开提交或参赛提交前，请运行 `npm run privacy-check`。

披露政策和安全演示规范请参阅 [SECURITY.md](SECURITY.md)。

## 测试

```bash
npm test              # v0.1 分析器 + v0.2 adapter + v0.2 CLI 端到端
npm run privacy-check # 公开提交前必须保持绿色
```

`npm test` 共九个用例，覆盖 `test/analyze.test.mjs`、`test/adapter.test.mjs`、`test/transcribe.test.mjs`。其中 CLI 集成测试要求环境能 `import mlx_whisper`；在 CI 等无法加载模型的场景下可设 `STORYCUT_SKIP_TRANSCRIBE_TESTS=1` 跳过。

## 架构

```text
浏览器审阅界面
       │
       ├── 粘贴路径：/api/analyze                （v0.1，确定性本地）
       │                                         └── 可选 GPT-5.6 Responses API
       │
       └── 媒体路径：/api/upload → /api/transcribe → /api/analyze-transcript （v0.2）
                              │                       │
                              ▼                       └── 复用 v0.1 决策引擎
                          MLX Whisper                  （通过 src/adapter.mjs 桥接）
                          （tools/transcribe.py）
                                 │
                          词级时间戳
                                 │
                          同样的 {KEEP, CUT, MOVE, B-ROLL} 提案
                                 │
                          人工接受 / 拒绝
                                 │
                          时间线 JSON 导出
```

可选的 AI 路径使用 Structured Outputs，让编辑决定符合固定的数据结构。GPT-5.6 负责编辑推理，确定性代码负责校验、对齐、审阅状态管理和导出。

## 后续路线图

- **P1：** 说话人分离（`pyannote/speaker-diarization-community-1`）
- **P1：** SRT 与 CMX3600 EDL 导出
- **P2：** FFmpeg 确定性粗剪渲染（仅在用户显式确认后执行）
- **P2：** 长视频分片 + 并行转写（R-4）

## 许可证

MIT
