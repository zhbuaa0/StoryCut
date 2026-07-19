#!/usr/bin/env python3
"""StoryCut local transcription CLI.

Wraps MLX Whisper. Emits NDJSON events to stdout, one event per line. Errors
are reported on stderr and the process exits non-zero so callers can detect
failure without parsing partial JSON.

Event protocol (stdout, one JSON object per line):

    {"type": "start",          "id": <fileId>, "input": "...", "model": "..."}
    {"type": "loaded_cache",   "path": "..."}        # when --output-dir cache hits
    {"type": "stage",          "stage": "loading_model" | "transcribing" | "post_processing",
                               ...stage-specific fields...}
    {"type": "saved_cache",    "path": "..."}        # when result was persisted
    {"type": "done",           "transcript": {...}}  # always last; success-only

Cache semantics: when --output-dir is provided, the transcript is keyed by a
short SHA-256 of the resolved input path + file size. A cache hit replays the
cached transcript and exits 0 without touching the model. Use --force to
bypass the cache (e.g. after changing --language or --model).

The "done" payload conforms to the Transcript shape required by REQUIREMENTS.md
FR-3.1 / FR-3.2 (seconds, 0.01s precision, word-level timestamps).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path


def log(event: dict) -> None:
    """Emit one NDJSON event on stdout, flushed so callers can stream."""
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def err(message: str) -> None:
    sys.stderr.write(f"transcribe: {message}\n")
    sys.stderr.flush()


def compute_file_id(path: Path) -> str:
    """Stable short id for caching. Path + size is enough for our scope."""
    sha = hashlib.sha256()
    sha.update(str(path).encode("utf-8"))
    try:
        sha.update(str(path.stat().st_size).encode("utf-8"))
    except OSError:
        # If stat fails (unlikely after the caller check), keep id path-only.
        pass
    return sha.hexdigest()[:16]


def cache_path_for(output_dir: str, file_id: str) -> Path:
    p = Path(output_dir) / f"{file_id}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def shape_word(raw: dict) -> dict | None:
    text = (raw.get("word") or "").strip()
    if not text:
        return None
    out = {
        "start": round(float(raw["start"]), 2),
        "end": round(float(raw["end"]), 2),
        "text": text,
    }
    probability = raw.get("probability")
    if probability is not None:
        try:
            out["confidence"] = round(float(probability), 3)
        except (TypeError, ValueError):
            pass
    return out


def shape_segment(raw: dict) -> dict | None:
    text = (raw.get("text") or "").strip()
    words_raw = raw.get("words") or []
    words = [w for w in (shape_word(w) for w in words_raw) if w is not None]
    if not text and not words:
        # Whisper itself blanks these out; drop them so consumers see only real beats.
        return None
    return {
        "start": round(float(raw.get("start", 0.0)), 2),
        "end": round(float(raw.get("end", 0.0)), 2),
        "text": text,
        "words": words,
    }


def shape_transcript(result: dict, file_id: str) -> dict:
    raw_segments = result.get("segments") or []
    segments = [s for s in (shape_segment(seg) for seg in raw_segments) if s]
    duration = max((s["end"] for s in segments), default=0.0)
    return {
        "id": file_id,
        "language": result.get("language") or "unknown",
        "duration": round(duration, 2),
        "segments": segments,
    }


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="transcribe",
        description="StoryCut local transcription CLI (MLX Whisper).",
    )
    parser.add_argument("--input", required=True, help="path to a local audio/video file")
    parser.add_argument(
        "--language",
        default="auto",
        help="ISO 639-1 code (en, zh, ...) or 'auto' for detection",
    )
    parser.add_argument(
        "--model",
        default="mlx-community/whisper-small-mlx",
        help="Hugging Face repo id with MLX-converted Whisper weights",
    )
    parser.add_argument(
        "--output-dir",
        help="if set, persist a cache JSON keyed by file id (resumable across runs)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="ignore cache, re-run transcription even if a cached JSON exists",
    )
    return parser.parse_args(argv)


def run(args: argparse.Namespace) -> int:
    input_path = Path(args.input).resolve()
    if not input_path.is_file():
        err(f"input not found or not a regular file: {input_path}")
        return 2

    file_id = compute_file_id(input_path)
    log({"type": "start", "id": file_id, "input": str(input_path), "model": args.model})

    cache_path: Path | None = None
    if args.output_dir:
        cache_path = cache_path_for(args.output_dir, file_id)
        if cache_path.exists() and not args.force:
            try:
                cached = json.loads(cache_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                err(f"cache unreadable ({exc}); deleting and re-running")
                try:
                    cache_path.unlink()
                except OSError:
                    pass
            else:
                log({"type": "loaded_cache", "path": str(cache_path)})
                log({"type": "done", "transcript": cached})
                return 0

    # Lazy-import so --help works even when MLX isn't installed.
    try:
        import mlx_whisper  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on host install
        err(f"mlx_whisper import failed: {exc}")
        return 3

    log({"type": "stage", "stage": "loading_model", "model": args.model})

    decode_options: dict = {}
    if args.language and args.language != "auto":
        decode_options["language"] = args.language

    log({"type": "stage", "stage": "transcribing", "input": str(input_path)})
    started_at = time.time()
    try:
        result = mlx_whisper.transcribe(
            str(input_path),
            path_or_hf_repo=args.model,
            word_timestamps=True,
            verbose=False,
            **decode_options,
        )
    except Exception as exc:
        err(f"transcribe failed: {exc}")
        return 4
    elapsed = round(time.time() - started_at, 2)
    log({"type": "stage", "stage": "post_processing", "elapsed_sec": elapsed})

    transcript = shape_transcript(result, file_id)

    if cache_path is not None:
        cache_path.write_text(
            json.dumps(transcript, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        log({"type": "saved_cache", "path": str(cache_path)})

    log({"type": "done", "transcript": transcript})
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return run(args)
    except KeyboardInterrupt:
        err("interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
