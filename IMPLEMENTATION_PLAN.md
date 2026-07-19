# StoryCut Local Media Pipeline · Implementation Plan v0.2

**Status:** Draft
**Date:** 2026-07-19
**Source requirements:** `REQUIREMENTS.md` (v0.2)
**Focus:** P0 — transcription + timecode alignment end-to-end

## 0. Decision summary (recap)

- Architecture: existing Node main server (`server.mjs`) shells out to a Python CLI for MLX Whisper
- CLI → server protocol: NDJSON over stdout (`progress` events + final `done`)
- Server → UI protocol: SSE for progress; JSON for final results
- Analyzer stays 100% compatible; new `src/adapter.mjs` glues the new shape in
- Frontend gets a minimal upload + progress panel; reuse v0.1 decision-card renderer
- All intermediates land under `.work/` (gitignored) keyed by a hashed `fileId`

## P0 task list

### T0 · Environment verification

Check the dev box has everything before we start the build.

- [ ] `node -v` ≥ 20
- [ ] `python3 --version` ≥ 3.10
- [ ] `ffmpeg -version`, `ffprobe -version` both available
- [ ] Apple Silicon confirmed (`uname -m` = `arm64`)
- [ ] `python3 -c "import mlx_whisper"` succeeds, **or** a clear installation plan is recorded
- [ ] `.env.example` lists `OPENAI_API_KEY`, `OPENAI_MODEL`, `HF_TOKEN` (P1)

If T0 fails, stop and remediate before continuing.

**Files touched:** none (only `.env.example` may grow)
**Acceptance:** green checklist posted back to chat; red items get remediation steps

---

### T1 · Python transcription CLI (`tools/transcribe.py`)

Tiny command-line wrapper around MLX Whisper.

- [ ] CLI flags: `--input`, `--language auto|en|zh|...`, `--output-dir`, `--model <mlx-repo>` (default `mlx-community/whisper-large-v3-turbo`)
- [ ] Emits NDJSON to stdout: `{type:"progress", processed_sec, total_sec}` events + final `{type:"done", transcript}`
- [ ] Transcript payload: `Transcript` per FR-3.1 (segments + words + confidence), `language`
- [ ] Persists result JSON under `--output-dir` keyed by SHA-256 of input path → resume-friendly
- [ ] Errors to stderr with non-zero exit; never writes partial JSON to stdout
- [ ] Local-only: only network is the model download step, run once, cached by Hugging Face

**Files added:** `tools/transcribe.py`, `tools/transcribe_test.py`
**Acceptance:** `python3 tools/transcribe.py --input tests/fixtures/short.wav --output-dir .work/` exits 0 and prints a `done` event with non-empty `words` and `segments`

---

### T2 · Node routes (`server.mjs` + helpers)

Add `/api/upload`, `/api/transcribe`, `/api/health` to the existing server.

- [ ] `/api/upload`: multipart → write to `.work/uploads/<fileId><ext>` → ffprobe metadata → `{ fileId, duration, ...ffprobe }`
- [ ] `/api/transcribe`: spawn `tools/transcribe.py`, parse NDJSON stream, forward progress to client via SSE, persist final result to `.work/transcripts/<fileId>.json`
- [ ] `/api/health`: returns `{ ok, mlx, pyannote, ffmpeg, ffprobe, hasOpenAIKey }`
- [ ] Reuse existing security headers (`headers()`); add explicit upload size middleware matching FR-1.5
- [ ] Extract `.work` path management into `src/upload-store.mjs` so routes stay declarative

**Files added/touched:** `server.mjs`, `src/upload-store.mjs`
**Acceptance:** `curl /api/health` returns JSON; upload + transcribe roundtrip on the fixture returns a transcript file on disk

---

### T3 · Analyzer adapter (`src/adapter.mjs`)

Bridge the new shape into v0.1's analyzer input — zero changes to the analyzer.

- [ ] Exports `timecodedTranscriptToAnalyzeInput(transcript)` → string consumable by `parseTranscript`
- [ ] Roundtrip test: T1 fixture output → adapter → `analyzeLocally` → decisions with non-empty array
- [ ] Re-export at module level so server can `import { timecodedTranscriptToAnalyzeInput } from "./src/adapter.mjs"`

**Files added:** `src/adapter.mjs`, `test/adapter.test.mjs`
**Acceptance:** all 3 v0.1 tests still pass; new adapter test passes

---

### T4 · Frontend minimal (`public/app.js`, `public/index.html`, `public/styles.css`)

Get from file-drop to decision review without rebuilding the review surface.

- [ ] Drag-drop zone + file picker, calls `/api/upload`
- [ ] After upload, hit `/api/transcribe` consuming the SSE progress stream
- [ ] Once done, hand the resulting transcript into the existing review pipeline (decisions render automatically)
- [ ] "Open media file" CTA appears next to existing "Load safe demo"
- [ ] Progress bar / stage marker visible during transcription (FR-2.5)

**Files touched:** `public/app.js`, `public/index.html`, `public/styles.css`
**Acceptance:** drag `tests/fixtures/short.wav`, watch progress, decision cards appear after a few seconds

---

### T5 · Test fixtures + privacy compliance

Make tests reliable without network or ML model downloads.

- [ ] `tests/fixtures/short.wav` (or `.mp3`) ~10–15 sec, license-clear, no PII, already gitignored under binary rules
- [ ] `tests/fixtures/short.expected.json`: hand-curated segment/word snapshot for diff
- [ ] `test/transcribe.test.mjs`: spawns the CLI with the fixture; asserts `words` and `segments` non-empty and shape-correct
- [ ] `test/adapter.test.mjs`: covers T3
- [ ] `npm run privacy-check` still green after the new files
- [ ] Confirms `.gitignore` covers `.work/`, `tests/fixtures/*.wav`, `tests/fixtures/*.mp3`

**Files added:** `tests/fixtures/short.wav`, `tests/fixtures/short.expected.json`, `test/transcribe.test.mjs`
**Acceptance:** `npm test` green; `npm run privacy-check` green

---

### T6 · Docs refresh

Keep `README.md`, `HANDOFF.md`, `.env.example` honest about the new pipeline.

- [ ] `README.md`: new section "Local media pipeline (v0.2)" — what's enabled, how to enable, what stays the same
- [ ] `HANDOFF.md`: bump "Current implementation" to mention P0 status; update "Recommended next milestone"
- [ ] `.env.example`: add `HF_TOKEN` for the (P1) diarization path

**Files touched:** `README.md`, `HANDOFF.md`, `.env.example`
**Acceptance:** docs match the actually-shipped behavior

---

## Cross-cutting decisions locked in

| Topic | Plan | Note |
|---|---|---|
| CLI vs HTTP for transcribe | CLI via `child_process` | Per HANDOFF + D-2 |
| Resume storage format | JSON file per `fileId` under `.work/transcripts/` | Simple; gitignored |
| Streaming protocol server → UI | SSE (built into Node) | No new deps |
| Frontend framework | Vanilla — same as v0.1 | Stay consistent with current shape |
| `.work/` location | Project root, gitignored | Single source of truth |

## Out of scope (P1 / P2)

- P1: speaker diarization with pyannote (FR-4.x)
- P1: SRT + EDL export (FR-6.x)
- P2: FFmpeg rough-cut render (FR-7.x)
- P2: long-video chunking + parallelism (R-4)

Each gets a follow-up plan after P0 lands.

## Open questions to confirm before T1

1. **OQ-1** P0 upload accepts only `mp4, mov, m4a, wav, mp3`. mkv / flac deferred. OK?
2. **OQ-2** Resume granularity = segment. OK?
3. **Model choice** Default `mlx-community/whisper-large-v3-turbo`; expose `--model` flag in CLI and `?model=` UI override. OK?
4. **Progress UX** SSE → in-page progress bar. Acceptable?
5. **`.work/` lifecycle** Persist between runs for resume; gitignored; never auto-purge in P0 (manual `rm -rf .work`). OK?
