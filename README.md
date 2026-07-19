# StoryCut

[English](README.md) | [简体中文](README.zh-CN.md)

**AI proposes. The creator decides.**

StoryCut is an explainable, human-in-the-loop rough-cut prototype for talking-head and vlog videos. It converts a transcript into reviewable `KEEP`, `CUT`, `MOVE`, and `B-ROLL` proposals, gives a reason for every decision, and exports an editable timeline JSON.

This repository contains the first public-safe MVP created for OpenAI Build Week in the **Work and Productivity** category.

## What works

**v0.1 (paste-transcript path)**

- Paste plain text, SRT, or VTT transcripts
- Run a deterministic local demo analyzer without an API key
- Optionally use GPT-5.6 through the server-side OpenAI Responses API
- Filter decisions and accept or reject every proposal
- Export reviewed decisions as timeline JSON
- Responsive, presentation-ready interface

**v0.2 (local media path)**

- Drop an mp4 / mov / m4a / wav / mp3 into the browser; the file never leaves the machine
- Server runs `tools/transcribe.py` over **MLX Whisper** on Apple Silicon and streams progress + the final timecoded transcript to the browser via SSE
- Word-level timestamps are preserved through transcription, alignment, and the existing decision engine
- Decisions from the media path land in the same review surface as the paste path

StoryCut v0.2 still does not upload source media, render a final cut, or persist project data.

## Run locally

Requirements: Node.js 20 or newer. macOS on Apple Silicon with MLX Whisper for the v0.2 media path. ffmpeg / ffprobe (Homebrew) for ffprobe metadata.

```bash
npm start
```

Open <http://127.0.0.1:4173>.

- For the **paste path** (works everywhere): choose **Load safe demo**, then **Analyze story**.
- For the **media path** (Apple Silicon): drop an mp4 / mov / m4a / wav / mp3 onto the upload zone, wait for transcription, and the same review surface opens with timecoded decisions.

No dependency installation is required for the Node server; `mlx_whisper` and `ffmpeg` must be on your `PATH` for the v0.2 media path.

## Optional GPT-5.6 mode

Keep API credentials on the server. Never place a key in `public/`, source code, screenshots, or commits.

```bash
export OPENAI_API_KEY="your-key"
export OPENAI_MODEL="gpt-5.6-terra"
npm start
```

When no key is configured, the app remains fully usable in local demo mode. Both the paste path (`/api/analyze`) and the media path (`/api/analyze-transcript`) honour this flag.

## v0.2 environment knobs

| Variable | Purpose | Default |
|---|---|---|
| `STORYCUT_MAX_UPLOAD_BYTES` | Upper bound for `/api/upload` body | `524288000` (500 MB) |
| `STORYCUT_WHISPER_MODEL` | MLX Whisper repo id for `tools/transcribe.py` | `mlx-community/whisper-small-mlx` |
| `STORYCUT_WORK_DIR` | Where uploaded media + cached transcripts live | `<repo>/.work` |
| `STORYCUT_SKIP_TRANSCRIBE_TESTS=1` | Skip the E2E transcribe test (e.g. in CI without the model cached) | unset |

## Privacy and security

- Source media is uploaded only to `127.0.0.1`; the bytes never leave the machine.
- Transcript text is processed in memory and is not written to disk.
- The API key is read only from the server environment and is never returned to the browser.
- Raw media, transcripts, secrets, environment files, and common key formats are git-ignored. The single committed audio fixture (`tests/fixtures/short.mp3`) is whitelisted in `.gitignore` and `scripts/privacy-check.mjs`; adding a new fixture requires a security review per `HANDOFF.md`.
- Requests are limited to 200 KB (analyzer) and 500 MB (upload) by default.
- The server binds to `127.0.0.1` by default and sends restrictive browser security headers.
- Run `npm run privacy-check` before any public commit or submission.

See [SECURITY.md](SECURITY.md) for the disclosure policy and safe demo guidance.

## Test

```bash
npm test              # v0.1 analyzer tests + v0.2 adapter tests + v0.2 CLI E2E
npm run privacy-check # must be green before every public commit
```

`npm test` runs nine tests across `test/analyze.test.mjs`, `test/adapter.test.mjs`, and `test/transcribe.test.mjs`. The CLI integration test is gated on `mlx_whisper` being importable; set `STORYCUT_SKIP_TRANSCRIBE_TESTS=1` to skip it.

## Architecture

```text
Browser review UI
       │
       ├── Paste path: /api/analyze            (v0.1, deterministic local)
       │                                       └── Optional GPT-5.6 via Responses API
       │
       └── Media path: /api/upload → /api/transcribe → /api/analyze-transcript (v0.2)
                              │                       │
                              ▼                       └── Same v0.1 decision engine
                          MLX Whisper                  (via src/adapter.mjs)
                          (tools/transcribe.py)
                                 │
                          Word-level timestamps
                                 │
                          Same {KEEP, CUT, MOVE, B-ROLL} proposals
                                 │
                          Human accept / reject
                                 │
                          Timeline JSON export
```

The optional AI path uses Structured Outputs so editorial decisions conform to a fixed schema. GPT-5.6 is used for editorial reasoning; deterministic code handles validation, alignment, review state, and export.

## Roadmap

- **P1:** Speaker diarization with `pyannote/speaker-diarization-community-1`
- **P1:** SRT and CMX3600 EDL export
- **P2:** Deterministic FFmpeg rough-cut rendering (only after explicit user review)
- **P2:** Long-video chunking + parallel transcription (R-4)

## License

MIT
