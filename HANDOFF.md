# StoryCut development handoff

Last updated: 2026-08-13

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

The repository now carries three additive workflows on the same zero-dependency Node.js core.

- **v0.4 (conversational edit workspace), updated 2026-08-09:**
  - `src/project-workspace.mjs`: treats StoryCut schema-v2 `activeVersion` and version entries as authoritative, registers every version's preview/EDL/subtitle/graphics/sound/review files, and safely exposes paired `clips_preview/` plus `clips_draft/` proxies
  - `src/edit-workspace.mjs`: builds a read-only, version-scoped source/shot model from the selected EDL; the media bin contains only assets actually used by that cut
  - `server.mjs`: `GET /api/edit/workspace` accepts `versionId`; the older propose/preview/apply/undo endpoints remain for compatibility, but the current UI does not call them
  - `public/`: version selector, normal/draft preview switch, proxy-backed media bin, 1–8× scrollable multi-track timeline, click/drag video seeking, per-version view memory, and opinion-only prompt generation
  - `src/media-cache.mjs`: bounded first-frame generation plus fingerprinted H.264/AAC playback proxies, single-job proxy throttling, adjustable LRU pruning, project ownership manifests, shared-artifact-safe project clearing, and bounded cache usage summaries
  - `src/project-index.mjs`: atomically persists a safe serialized project scan under `~/Library/Caches/StoryCut/project-index`; normal opens validate active/key artifacts and reuse the scan, while explicit refreshes rebuild it
  - `server.mjs`: cache status/clear/settings/open routes expose only known rebuildable cache sections and a fixed cache root; project-open responses report whether the persistent index was reused or rebuilt
  - `src/edit-compare.mjs` plus `/api/edit/compare`: pure version comparison for clips and packaging markers, matching source identity before interval overlap and reporting added/removed/trimmed/extended/moved changes
  - The preview supports muted, master/follower A/B comparison, A/split/B layouts, drift correction, and a clickable delta lane. Large media bins render in 40-item batches, and the synchronous-audio lane is a single waveform/boundary SVG instead of one DOM group per clip
  - Incremental graphics plans follow `base_preview`, so later revisions inherit earlier flower text and chapter cards instead of showing additions alone
  - Each opinion records version, preview file, playback time, and selected asset/shot. Multiple opinions persist only in browser-local storage and are grouped by version in the final Codex prompt
  - The current Edit workspace does not write operations, draft EDLs, subtitles, or source media. Future agents must not reconnect the legacy apply endpoints without explicit product approval
  - 2026-08-13 stability pass: project IDs are deterministic and an expired in-memory session restores from the persistent index, so browser-local recent projects remain usable after a server restart
  - Both Edit and Video Review can use the bounded H.264/AAC playback-proxy cache. Hidden tabs unload media and suspend polling; invalid proxy files fall back to project media while preserving the playback position
  - Video Review limits its version selector to version-level or explicit whole-film previews; clip proxies, master-segment folders, and animation assets remain available elsewhere but are excluded from that high-frequency control
  - Generating an opinion Prompt now archives the batch and clears pending opinions. Revisions can be viewed, copied, deleted, or restored for another iteration; all of this remains browser-local and opinion-only

- **v0.3 (Codex local review workspace), shipped 2026-07-29:**
  - `src/project-workspace.mjs`: inspects artifacts under an explicitly opened local `edit/` directory, parses SRT/ASS, builds review markers from EDL and packaging plans, and creates versioned review rounds
  - `server.mjs`: adds `/api/projects/open`, `/api/projects/file`, `/api/projects/document`, `/api/reviews`, `/api/reviews/timeline`, and `/api/reviews/subtitle-corrections`
  - `public/`: project overview, video review with live current subtitles, inline correction, filterable click-to-jump edit/SFX/flower/chapter/BGM markers, timecoded feedback, project-file browser, and the original analyzer on a separate AI Analysis page
  - `edit/review/`: runtime output containing `current.json`, `subtitle-corrections.json`, human-readable Markdown, versioned rounds, and generated Codex prompts. Subtitle corrections are a sidecar and never overwrite the source subtitle
  - `test/project-workspace.test.mjs`: project discovery, safe document reading, marker extraction, non-destructive subtitle correction, and review-file generation tests

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

The app still does not upload source media externally or render an authoritative full-film final. Explicit Video Review rounds remain inside `edit/review/`; Edit workspace opinions and timeline view state remain browser-local and only generate text prompts.

### Run and verify

```bash
npm start             # boots the local HTTP server on 127.0.0.1:4173
npm test              # analyzer + workspace + edit-operation tests; CI may set STORYCUT_SKIP_TRANSCRIBE_TESTS=1
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
