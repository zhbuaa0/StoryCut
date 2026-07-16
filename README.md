# StoryCut

**AI proposes. The creator decides.**

StoryCut is an explainable, human-in-the-loop rough-cut prototype for talking-head and vlog videos. It converts a transcript into reviewable `KEEP`, `CUT`, `MOVE`, and `B-ROLL` proposals, gives a reason for every decision, and exports an editable timeline JSON.

This repository contains the first public-safe MVP created for OpenAI Build Week in the **Work and Productivity** category.

## What works in v0.1

- Paste plain text, SRT, or VTT transcripts
- Run a deterministic local demo analyzer without an API key
- Optionally use GPT-5.6 through the server-side OpenAI Responses API
- Filter decisions and accept or reject every proposal
- Export reviewed decisions as timeline JSON
- Responsive, presentation-ready interface

StoryCut v0.1 analyzes transcript text only. It does not upload video, render a final cut, or persist project data.

## Run locally

Requirements: Node.js 20 or newer.

```bash
npm start
```

Open <http://127.0.0.1:4173>, choose **Load safe demo**, then select **Analyze story**.

No dependency installation is required.

## Optional GPT-5.6 mode

Keep API credentials on the server. Never place a key in `public/`, source code, screenshots, or commits.

```bash
export OPENAI_API_KEY="your-key"
export OPENAI_MODEL="gpt-5.6-terra"
npm start
```

When no key is configured, the app remains fully usable in local demo mode.

## Privacy and security

- Transcript text is processed in memory and is not written to disk.
- The API key is read only from the server environment and is never returned to the browser.
- Raw media, transcripts, secrets, environment files, and common key formats are git-ignored.
- Requests are limited to 200 KB and transcripts to 30,000 characters.
- The server binds to `127.0.0.1` by default and sends restrictive browser security headers.
- Run `npm run privacy-check` before any public commit or submission.

See [SECURITY.md](SECURITY.md) for the disclosure policy and safe demo guidance.

## Test

```bash
npm test
npm run privacy-check
```

## Architecture

```text
Browser review UI
       │
       ├── Local demo analyzer (default, deterministic)
       │
       └── Server-side Responses API (optional)
                         │
                  Structured decisions
                         │
                 Human accept / reject
                         │
                  Timeline JSON export
```

The optional AI path uses Structured Outputs so editorial decisions conform to a fixed schema. GPT-5.6 is used for editorial reasoning; deterministic code handles validation, review state, and export.

## Roadmap

- Local Whisper transcription and timecode alignment
- Thumbnail and frame context for multimodal review
- Editable move targets and B-roll briefs
- Deterministic FFmpeg rough-cut rendering
- SRT and EDL export

## License

MIT
