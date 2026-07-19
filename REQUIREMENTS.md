# StoryCut Local Media Pipeline · Requirements v0.2

**Status:** Draft
**Date:** 2026-07-19
**Based on:** `HANDOFF.md` §"Recommended next milestone", `README.md` §"Roadmap", v0.1 product principles
**Current focus (per user):** Transcription + timecode alignment

## 1. Goals

Extend v0.1 (paste-transcript → decision engine) into "drop in a local media file → automatic transcription with timecodes → same decision engine". The pipeline runs **fully locally**; source media is never silently uploaded.

## 2. Non-goals

- No cloud transcription or cloud diarization
- No video effects, transitions, color grading
- No project management, collaboration, or cloud sync
- No automatic editing — humans must explicitly accept/reject before any export renders
- No speaker identification (which real person is `SPEAKER_NN`) — diarization-only

## 3. User stories

| ID | As a | I want to | So that |
|---|---|---|---|
| US-1 | vlog creator | drag an mp4/mov into the browser | I don't have to transcribe elsewhere first |
| US-2 | vlog creator | see timecoded + speaker-labelled transcript | I can locate any text back in source video |
| US-3 | vlog creator | feed that transcript into the same decision engine | I keep the v0.1 review workflow |
| US-4 | multi-speaker creator | see who said each segment | I can rough-cut by speaker |
| US-5 | creator | export SRT + EDL + timeline JSON after reviewing | I can hand off to Premiere / DaVinci |
| US-6 | creator | one-click FFmpeg rough-cut preview | I verify decisions before polishing |

## 4. Functional requirements

### 4.1 Media import  — `P0`

- **FR-1.1** Browser: file selection (`<input type="file" accept="video/*,audio/*">`) + drag-and-drop
- **FR-1.2** Accepted formats: mp4, mov, m4a, wav, mp3
- **FR-1.3** File never leaves the machine: uploaded to local server, never to any external host
- **FR-1.4** Server uses ffprobe to extract duration, sample rate, channel count, resolution; return to UI
- **FR-1.5** Default upload limit: 500 MB (configurable); oversize → 413

### 4.2 Transcription  — `P0`

- **FR-2.1** Backend: **MLX Whisper** exclusively (Apple Silicon). On non-Apple Silicon / unsupported hardware, fail loudly with a clear message — never silently fall back to slower alternatives
- **FR-2.2** Language policy: default auto-detect; user can switch `auto / en / zh / ...` in UI
- **FR-2.3** Preserve **word-level timestamps** (HANDOFF requirement); also aggregate to segments
- **FR-2.4** Output shape: words `[{start, end, text, confidence}]`; segments `[{start, end, text, words}]`
- **FR-2.5** Progress must be observable: %, "processed mm:ss", or stage markers. No black-box waits.
- **FR-2.6** Intermediate outputs persist to project working directory so long jobs can resume after crash

### 4.3 Timecode alignment  — `P0`

- **FR-3.1** Output shape contract: `Transcript { duration, language, segments: Segment[] }` with `Segment { start, end, text, words, speaker? }`
- **FR-3.2** Internal representation: **seconds (float, 0.01s precision)**. Format on export.
- **FR-3.3** Boundary rules: `end ≥ start` always; adjacent segments may overlap by ≤ 0.05s (tolerate Whisper endpoint jitter); forbid segments covering the same time window
- **FR-3.4** v0.1 surface (`parseTranscript` / `analyzeLocally` / `normalizeDecisions`) **unchanged**; align via a thin adapter instead

### 4.4 Speaker diarization  — `P1`

- **FR-4.1** Optional feature using `pyannote/speaker-diarization-community-1`
- **FR-4.2** pyannote HF token: server-side env var only, never exposed to browser
- **FR-4.3** Output: speaker intervals `[{speaker, start, end}]`
- **FR-4.4** Align diarization intervals to Whisper words by interval containment; assign `speaker` per word; segment-level speaker = majority word count or weighted duration
- **FR-4.5** Speaker labels stay `SPEAKER_<NN>` — no speaker identification (see §2)

### 4.5 Decision engine integration  — `P0`

- **FR-5.1** v0.1 functions: signatures & behavior **fully preserved**
- **FR-5.2** New thin adapter (`src/adapter.mjs`): `timecodedTranscriptToAnalyzeInput(transcript)` → existing analyze input shape
- **FR-5.3** Optional AI path: schema accepts optional `speaker` field without breaking the existing strict schema

### 4.6 Export  — `P1`

- **FR-6.1** Additions to v0.1 timeline JSON export:
  - `exportSRT(decisions)` → SRT subtitle file
  - `exportEDL(decisions)` → CMX3600 EDL (Premiere / DaVinci compatible)
- **FR-6.2** Only **accepted** decisions land in SRT / EDL; rejected decisions remain in timeline JSON review log
- **FR-6.3** B-ROLL decisions exported as EDL comments or sidecar JSON; never forced onto the main video track

### 4.7 FFmpeg rough-cut render  — `P2`

- **FR-7.1** Only after explicit "Render rough-cut" confirmation — irreversible
- **FR-7.2** Generate FFmpeg concat demuxer from accepted decisions: `ffmpeg -ss -to` per segment, then concat
- **FR-7.3** No re-encoding when possible: preserve codec, resolution, audio; respects NFR-3 determinism + speed
- **FR-7.4** Server-side render with polled progress and cancellation support

## 5. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-1 | Privacy | Source media never leaves the machine. Even the OpenAI path receives only transcript text. |
| NFR-2 | Dependency isolation | Heavy ML deps (MLX, pyannote) live in a separate Python service/CLI; current Node main stays zero-deps |
| NFR-3 | Determinism | Same input → byte-identical SRT / EDL output (excluding ephemeral fields) |
| NFR-4 | Recoverability | Long transcription that crashes mid-run can resume from last completed segment |
| NFR-5 | Memory | Word-level arrays must not blow up memory; chunk or stream when source > 1h |
| NFR-6 | Error UX | Missing ML, missing HF token, ffprobe failures → human-friendly errors, no stack traces |
| NFR-7 | Security headers | Reuse v0.1 CSP / Permissions-Policy. New upload routes get explicit upload size limits. |
| NFR-8 | Test coverage | Each FR covered by ≥1 unit or e2e smoke test; transcription / diarization tested against fixtures — **no live network, no live model downloads in CI** |

## 6. API contract

New endpoints (alongside v0.1's `/api/analyze`, `/api/status`):

```
POST /api/upload            upload media → { fileId, duration, ...ffprobe }
POST /api/transcribe        { fileId, language? } → { segments, words, duration }
POST /api/diarize           { fileId } → { speakers: [{start, end, speaker}] }   // optional
POST /api/align             { transcript, diarization? } → aligned transcript
POST /api/render            { transcript, decisions, acceptedIds } → { renderId }
GET  /api/render/:id        render progress
GET  /api/health            MLX / pyannote / ffmpeg / ffprobe availability
```

`/api/transcribe` response shape lines up with v0.1's analyzer input — they flow into each other.

## 7. Data model

```ts
Word       = { start: number, end: number, text: string, confidence?: number, speaker?: string }
Segment    = { start: number, end: number, text: string, words: Word[], speaker?: string }
Transcript = { duration: number, language: string, segments: Segment[] }
Decision   = (v0.1 fields) + optional speaker
Project    = { id, sourcePath, transcript, decisions, review, createdAt, updatedAt }
```

## 8. Key design decisions

| # | Decision | Alternatives | Reason |
|---|---|---|---|
| D-1 | MLX Whisper is the sole P0 transcription backend | faster-whisper / whisper.cpp | HANDOFF explicitly prioritizes Apple Silicon |
| D-2 | Transcription lives in a separate Python CLI; Node calls via `child_process` | Embed Python in Node; long-running HTTP sidecar | HANDOFF: "separate local service or CLI at first" — easier deps, easier testing |
| D-3 | AI path only sees transcript text, never audio/video bytes | — | NFR-1 |
| D-4 | Don't modify v0.1 analyzer signatures; add adapter | Refactor `parseTranscript` | Lowest risk; keeps 3 existing tests green |
| D-5 | pyannote HF token read server-side only | Frontend-readable | NFR-1 + token hygiene |
| D-6 | FFmpeg rough-cut is stream-copy when possible | Re-encode | NFR-3 determinism + speed |
| D-7 | Progress streamed as NDJSON on stdout from Python CLI | Polling log file | Single source of truth, no race |

## 9. Risks & open questions

- **R-1** MLX has known platform / Xcode compatibility edges; document minimum macOS / Xcode
- **R-2** `pyannote-community-1` license + commercial-use scope needs legal review before wider release
- **R-3** Segment-spanning-multiple-speaker alignment is ambiguous; FR-4.4 needs a tie-break rule documented with rationale
- **R-4** Long-video (>1h) transcription: chunking + parallelism not in P0; revisit if users complain
- **OQ-1** Does the upload accept mkv / flac in P0 or only mp4 / mov / m4a / wav / mp3?
- **OQ-2** Resume granularity: by segment or by word? Segment is the simpler MVP.

## 10. Acceptance criteria (P0)

1. Drop a local mp4; end-to-end reaches the review screen with non-empty decision cards
2. Hovering a decision card shows the original media time range; word timestamps available in DOM
3. With pyannote uninstalled, the full P0 flow still completes (diarization is optional)
4. `npm test` and `npm run privacy-check` both green. New tests cover FR-2 / FR-3 / FR-5
5. All three v0.1 tests still pass — interface compatibility proof
6. With network disabled, the full local flow completes. Outbound traffic is 0 unless the user explicitly invokes AI mode
