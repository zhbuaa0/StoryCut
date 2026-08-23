# StoryCut

[English](README.md) | [简体中文](README.zh-CN.md)

**AI 提出建议，创作者做出决定。**

StoryCut 是 Codex 视频剪辑工作流的本地审片与反馈界面。它把 Codex 已生成的审片视频、项目记忆、故事方案、字幕和 EDL 整理到一个工作台，让创作者用时间码表达观看感受，再生成可直接交回 Codex 的结构化反馈文件和 Prompt。

本仓库包含为 OpenAI Build Week **Work and Productivity** 类别开发的首个公开安全 MVP。

## 已实现功能

**v0.3（Codex 本地审片工作台）**

- 打开一个已有的本地视频项目或 `edit/` 目录
- 自动识别最新审片视频、`project.md`、EDL、字幕、转写和包装方案
- 在当前浏览器本地缓存最近项目和未提交的审片建议，重新打开后可一键继续
- 项目生成新版本后可直接“刷新项目”，重新识别最新成片、字幕、BGM 和音效节点
- “审片版本”只列版本级整片与明确的独立成片，分段代理和动画素材不会再塞入下拉框拖慢页面
- 播放时在反馈面板顶部同步显示当前字幕并可直接校正；修改写入 `edit/review/subtitle-corrections.json`，不会覆盖原字幕
- 视频与字幕/剪辑节点索引共用同一审片工作区；手动拖动到节点附近会自动切换并定位节点列表，点击整行也可精确跳转
- 支持 `0.5×` 至 `2.0×` 播放倍速
- 从 EDL 和包装方案提取剪辑点、音效、花字、章节卡与 BGM 节点，并提供分类筛选与全片概览
- 视频审片页也会在后台生成并复用本机 H.264/AAC 播放代理；代理异常时自动回退项目原视频并保留播放位置
- 在视频播放位置添加带开始/结束时间码的创作反馈
- 记录修改意图、必须保留内容、优先级和 `LOCK`
- 把一轮意见保存为 `edit/review/current.json`、Markdown 记录和 Codex Prompt
- 项目文件分类浏览与文本预览
- 所有项目路径、视频和反馈仅由本机服务处理

**v0.4（对话剪辑工作台）**

- 新增「剪辑工作台」：对话意见、当前版本入片素材、预览和多轨整片时间线集中在一个页面
- 按 StoryCut schema v2 的 `activeVersion` 和版本清单读取工程；可在 `rough_cut_vN_rM` 之间切换，预览、EDL、字幕、包装节点和素材代理会整体同步
- 素材池只统计当前版本 EDL 中真实入片的镜头，逐条显示对应版本的 `clips_preview/` 或 `clips_draft/` 代理；点击代理片段可直接跳到其正片时间
- 花字增量版会沿 `base_preview` 显式继承上一版包装，不再只显示新加花字
- 多轨时间线支持 1–8× 缩放、横向滚动、适配全片、点击定位和拖动播放头；花字与章节卡按真实起止时间绘制，并以避让标签解决短区间空白，时间尺会随缩放切换带数值的主次刻度
- 意见可填写起止时间，并绑定审片版本、审片文件、播放位置以及所选镜头或包装节点（花字、章节卡、BGM、音效）；可多选、编辑、删除并持续加入，生成 Prompt 后自动清空待整理列表并归档到“修订记录”
- 已归档修订可一键恢复成待整理意见，继续修改并生成下一轮 Prompt
- 当前界面只记录意见和生成 Prompt，不直接修改素材、EDL、字幕或项目文件；意见与时间线视图只保存在浏览器本地缓存
- 剪辑工作台会为当前 A、B 两个版本及两种画质在本机 SSD 异步生成浏览器专用 H.264/AAC 播放代理：最长边 1280、约 2 Mbps、2 秒 GOP、MP4 `faststart`；单任务限流，完成前自动回退原视频，代理按源文件指纹复用，LRU 上限默认 20 GB 且可在界面调整
- 支持 A/B 同步审片：A 作为主播放器，B 自动静音并跟随播放、暂停、倍速和时间码；可选择只看 A、分屏、只看 B，按 `\` 快速轮换，并通过版本差异轨道查看新增、删除、收紧、延长和移动的镜头或包装节点
- 首次扫描会生成持久化项目索引和稳定项目 ID；再次打开或服务重启后只校验活跃版本和关键文件即可恢复，点击“刷新项目/重新读取”仍可强制完整扫描
- 大素材池先渲染 40 条，再随滚动或按钮按批加载；同期声轨改为单条轻量波形与切点路径，避免长项目一次创建数千个 DOM 节点
- 内置本地缓存面板，可分别查看全部项目与当前项目占用；支持只清当前项目、保留其他项目共享文件、设置 1–200 GB 播放代理上限，以及在 Finder 打开固定缓存目录

原来的转录分析现在位于工作台的 **AI 分析** 页面。

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

StoryCut 不负责替代专业时间线。Codex 和本地剪辑 skill 继续负责权威 EDL、字幕、包装和最终成片；StoryCut 负责把用户在不同审片版本上的意见整理为带时间码、资产引用和版本上下文的 Prompt，再交回 Codex 执行。

## 本地运行

环境要求：Node.js 20 或更高。v0.2 媒体路径还需要：Apple Silicon 上的 macOS、MLX Whisper、ffmpeg / ffprobe（Homebrew）。

```bash
npm start
```

打开 <http://127.0.0.1:4173>，点击 **打开项目**，输入包含 `edit/` 的本地视频项目目录。

进入 **视频审片** 后，右侧反馈面板会同步显示当前字幕。直接修改并点击 **保存校正** 即可记录待处理修订；播放器与节点索引位于同一工作区，手动拖到节点附近会自动切换并定位节点列表。剪辑点、音效、花字、章节卡和 BGM 均可点击跳转和按类型筛选，工具栏也可调整播放倍速。

进入 **剪辑工作台** 后，先选择要审的版本，再点击一个素材或镜头，输入“这条不用剪”“把这段收紧”“选取某素材的 00:01–00:03”等意见并点击 **加入意见**。可以跨版本连续记录，最后点击 **生成总 Prompt**；这一过程不会直接改动项目文件。

首次打开某一版本时，StoryCut 会在后台生成本机播放代理，并在预览区显示进度；生成期间仍可使用项目原视频，完成后播放器会保持当前时间点自动切换到代理。源文件的路径、大小或修改时间发生变化时，会自动生成新的代理，不会误用旧缓存。

需要比较两个版本时，在剪辑工作台点击 **A/B 对比**。A 仍是唯一的播放控制源，B 会静音并同步跟随；可用 **只看 A / 分屏 / 只看 B** 或 `\` 切换，并点击 Δ 版本差异轨道定位变化。点击 **缓存** 可区分全部与当前项目占用、仅清当前项目、调整代理容量或打开缓存目录。正常重新打开会复用项目索引，只有明确点击刷新时才进行完整扫描。

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
| `STORYCUT_CACHE_DIR` | 首帧图片和播放代理的本机缓存根目录 | `~/Library/Caches/StoryCut` |
| `STORYCUT_PROJECT_INDEX_DIR` | 持久化项目索引目录 | `~/Library/Caches/StoryCut/project-index` |
| `STORYCUT_MEDIA_CACHE_MAX_BYTES` | 播放代理缓存总上限 | `21474836480`（20 GB） |
| `STORYCUT_CACHE_RESERVE_BYTES` | 生成代理时预留的本机可用空间 | `1073741824`（1 GB） |
| `STORYCUT_PROXY_MAX_EDGE` | 播放代理最长边 | `1280` |
| `STORYCUT_PROXY_VIDEO_BITRATE` | 播放代理目标视频码率（bit/s） | `2000000` |
| `STORYCUT_PROXY_AUDIO_BITRATE` | 播放代理 AAC 码率（bit/s） | `128000` |

## 隐私与安全

- 源媒体仅上传到 `127.0.0.1`，字节流不会离开本机。
- 播放代理和首帧图片只写入当前用户的 StoryCut 本机缓存目录，不修改源素材或项目内已确认版本。
- 转录文本仅在内存中处理，不写入磁盘。
- 审片字幕校正只写入项目内的独立 sidecar 文件，不修改或覆盖原始 SRT/ASS。
- 最近项目路径和未提交建议仅保存在当前浏览器的本地缓存中，不会上传；清除浏览器站点数据会同时清除这些缓存。
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

`npm test` 覆盖分析器、转写 adapter、本地项目工作台、审片节点、字幕安全校正、对话剪辑操作、局部预览降级、草稿 EDL 持久化和 CLI 集成。CLI 集成测试要求环境能 `import mlx_whisper`；在 CI 等无法加载模型的场景下可设 `STORYCUT_SKIP_TRANSCRIBE_TESTS=1` 跳过。

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

可选的 AI 路径使用 Structured Outputs，让编辑决定符合固定的数据结构。GPT-5.6 负责编辑推理，确定性代码负责校验、对齐、审阅状态管理、剪辑操作解析、局部预览和导出。

## 后续路线图

- **P1：** 说话人分离（`pyannote/speaker-diarization-community-1`）
- **P1：** SRT 与 CMX3600 EDL 导出
- **P2：** 基于已确认草稿 EDL 的全片 FFmpeg 确定性粗剪渲染
- **P2：** 长视频分片 + 并行转写（R-4）

## 许可证

MIT
