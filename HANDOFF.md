# StoryCut development handoff

Last updated: 2026-07-19

This file is the working handoff for the next developer or coding model. Read it together with `README.md`, `README.zh-CN.md`, and `SECURITY.md` before changing the project.

## Project intent

StoryCut is an explainable, human-in-the-loop rough-cut assistant for talking-head and vlog footage. It should analyze a transcript and propose structured editing decisions:

- `KEEP`: retain a useful story beat
- `CUT`: remove mistakes, repetition, filler, or weak passages
- `MOVE`: improve narrative order
- `B-ROLL`: suggest supporting visuals

Every suggestion needs a concise reason. The creator remains in control by accepting or rejecting suggestions before export.

The project was started for the OpenAI Build Week **Work and Productivity** category.

## Current implementation

The repository now carries two versions side by side, both built on the same zero-dependency Node.js core.

- **v0.1 (paste path):**
  - `server.mjs`: local HTTP server with `/api/analyze`, `/api/status`, static UI
  - `src/analyze.mjs`: deterministic local transcript analyzer with `KEEP/CUT/MOVE/B-ROLL`
  - `public/`: browser review interface (paste textarea, decision cards, JSON export)
  - `test/analyze.test.mjs`: 3 tests
  - `scripts/privacy-check.mjs`: scans tracked files for private data

- **v0.2 (local media path), shipped 2026-07-19:**
  - `tools/transcribe.py`: MLX Whisper CLI. NDJSON stdout, language + model overrides, sha256-keyed cache, defensive shape functions
  - `src/upload-store.mjs`: path helpers, ffprobe wrapper, fileId format, allowed-extension whitelist
  - `src/health.mjs`: `/api/health` probe (ffmpeg/ffprobe/mlx_whisper/pyannote, hasOpenAIKey)
  - `src/adapter.mjs`: pure-function bridge from the new `Transcript` shape to v0.1's `parseTranscript` input. Zero changes to v0.1 surface
  - `server.mjs`: adds `/api/upload` (raw bytes + `X-Filename`), `/api/transcribe` (SSE stream of CLI NDJSON), `/api/analyze-transcript`, `/api/health`. Upload size bounded by `STORYCUT_MAX_UPLOAD_BYTES` (default 500 MB), transcripts bounded by 80 segments
  - `public/`: new "Drop a local media file" panel with drag-drop, progress bar, and SSE-driven UI
  - `test/adapter.test.mjs`: 5 tests covering shape, defensive clamps, full analyzer roundtrip
  - `test/transcribe.test.mjs`: 1 E2E test that spawns the CLI on `tests/fixtures/short.mp3` and asserts shape. Skipped under `STORYCUT_SKIP_TRANSCRIBE_TESTS=1` or when `mlx_whisper` is unavailable
  - `tests/fixtures/short.mp3`, `tests/fixtures/short.expected.json`: the single synthetic audio fixture. `.gitignore` and `privacy-check.mjs` whitelist this path exclusively; widening the list requires a security review

The app still does not upload source media externally, render video, or persist project data. With network disabled, the v0.2 flow completes locally apart from one model download (cached afterwards).

### Run and verify

```bash
npm start             # boots the local HTTP server on 127.0.0.1:4173
npm test              # 9 tests; CI may set STORYCUT_SKIP_TRANSCRIBE_TESTS=1
npm run privacy-check # must be green before every push
git status --short
git diff --cached
```

### Optional model path

```bash
export OPENAI_API_KEY="your-key"
export OPENAI_MODEL="gpt-5.6-terra"
export STORYCUT_WHISPER_MODEL="mlx-community/whisper-small-mlx"   # default; "small-mlx" suffix is required
npm start
```

Never place credentials in source files, browser code, screenshots, logs, fixtures, or commits.

## Run and verify

Requires Node.js 20 or newer. There are currently no third-party npm dependencies.

```bash
npm start
```

Open <http://127.0.0.1:4173>.

Before every commit or push:

```bash
npm test
npm run privacy-check
git status --short
git diff --cached
```

## Optional model path

The default demo analyzer works without credentials. The server also contains an optional OpenAI Responses API path configured only through server-side environment variables:

```bash
export OPENAI_API_KEY="your-key"
export OPENAI_MODEL="gpt-5.6-terra"
npm start
```

Never place credentials in source files, browser code, screenshots, logs, fixtures, or commits.

## Recommended next milestone

P0 (transcription + timecode alignment) is **shipped in v0.2**. The remaining work splits across two later milestones:

### P1 — speaker labels + export formats

1. Optional speaker diarization with `pyannote/speaker-diarization-community-1`. Token from server-side `HF_TOKEN` env var only.
2. Align diarization intervals to Whisper words by interval containment; assign `speaker` per word and per segment (majority word count or weighted duration).
3. Allow the strict-schema AI path to accept an optional `speaker` field on Word / Segment without breaking existing clients.
4. Add `exportSRT(decisions)` (only **accepted** decisions) and `exportCMX3600(decisions)` (Premiere / DaVinci compatible). B-ROLL decisions exported as EDL comments or sidecar JSON, never onto the main video track.

### P2 — FFmpeg rough-cut rendering + long-video support

1. Render only after explicit "Render rough-cut" confirmation — single irreversible action.
2. Stream-copy preferred (no re-encode) for determinism + speed; concat demuxer from accepted decisions.
3. Server-side render with polled progress and cancellation; aborting closes the spawned FFmpeg cleanly.
4. Long-video (>1h) chunking + parallelism if user load justifies the engineering cost (R-4).

Keep both milestones additive — neither should require touching v0.1's `parseTranscript` or its 3 existing tests.

## Product principles

- Suggestions are explainable and reversible.
- AI proposes; the creator decides.
- Deterministic code validates model output and performs exports.
- Prefer local media processing where practical.
- Never silently upload source media.
- Preserve useful timestamps and provenance through every pipeline stage.
- Keep demo inputs synthetic or explicitly cleared for public use.

## Privacy boundary

Do not commit or push any of the following:

- names, email addresses, account identifiers, or private local paths
- API tokens, `.env` files, SSH keys, cookies, or browser/session data
- personal footage, voices, images, transcripts, subtitles, or generated exports
- metadata that can identify a person or location without documented consent

The existing `.gitignore`, `SECURITY.md`, and privacy scanner are part of the product and must not be weakened without a clear security review.

## Git and repository

- Main branch: `main`
- Use `pwd` to confirm the local checkout and `git remote -v` to inspect its configured remote.

Do not rewrite published history or force-push unless the repository owner explicitly requests it.
