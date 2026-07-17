# StoryCut

[English](README.md) | [简体中文](README.zh-CN.md)

**AI 提出建议，创作者做出决定。**

StoryCut 是一款面向口播和 Vlog 视频的、可解释且有人参与决策的粗剪原型。它能把转录文本转换为可审阅的 `KEEP`、`CUT`、`MOVE` 和 `B-ROLL` 建议，为每项决定提供理由，并导出可编辑的时间线 JSON。

本仓库包含为 OpenAI Build Week **Work and Productivity** 类别开发的首个公开安全 MVP。

## v0.1 已实现功能

- 粘贴普通文本、SRT 或 VTT 转录稿
- 无需 API Key，使用确定性的本地演示分析器
- 可选：通过服务端 OpenAI Responses API 使用 GPT-5.6
- 按决策类型筛选，并接受或拒绝每条建议
- 将审阅后的决定导出为时间线 JSON
- 适合演示的响应式界面

StoryCut v0.1 目前只分析转录文本，不上传视频、不渲染最终成片，也不持久化保存项目数据。

## 本地运行

环境要求：Node.js 20 或更高版本。

```bash
npm start
```

打开 <http://127.0.0.1:4173>，点击 **Load safe demo**，再点击 **Analyze story**。

本版本无需安装任何第三方依赖。

## 可选的 GPT-5.6 模式

API 凭证必须保留在服务端。请勿把 Key 放入 `public/`、源代码、截图或 Git 提交中。

```bash
export OPENAI_API_KEY="your-key"
export OPENAI_MODEL="gpt-5.6-terra"
npm start
```

未配置 Key 时，应用仍可完整使用本地演示模式。

## 隐私与安全

- 转录文本仅在内存中处理，不写入磁盘。
- API Key 只从服务端环境变量读取，绝不会返回浏览器。
- 原始媒体、转录稿、密钥、环境配置文件和常见私钥格式均已加入 Git 忽略规则。
- 请求大小限制为 200 KB，转录文本限制为 30,000 个字符。
- 服务默认只监听 `127.0.0.1`，并发送严格的浏览器安全响应头。
- 每次公开提交或参赛提交前，请运行 `npm run privacy-check`。

披露政策和安全演示规范请参阅 [SECURITY.md](SECURITY.md)。

## 测试

```bash
npm test
npm run privacy-check
```

## 架构

```text
浏览器审阅界面
       │
       ├── 本地演示分析器（默认、确定性）
       │
       └── 服务端 Responses API（可选）
                         │
                    结构化决策
                         │
                   人工接受 / 拒绝
                         │
                  时间线 JSON 导出
```

可选的 AI 路径使用 Structured Outputs，让编辑决定符合固定的数据结构。GPT-5.6 负责编辑推理，确定性代码负责校验、审阅状态管理和导出。

## 后续路线图

- 本地 Whisper 转录和时间码对齐
- 使用缩略图和视频帧提供多模态上下文
- 可编辑的片段移动目标和 B-roll 简报
- 使用 FFmpeg 确定性渲染粗剪视频
- 导出 SRT 和 EDL

## 许可证

MIT
