# WORKER_IPC — LUDO Phase 1

This document defines the current desktop transcription boundaries for local worker and server ASR paths.

## Boundary

Frontend (`React`)
- calls Tauri command: `run_python_file_transcription`
- calls Tauri command: `run_python_microphone_chunk_transcription`
- payload includes:
  - `session` (provider-neutral session metadata)
  - `backend` (`local_gpu` | `local_cpu` | `azure_server`)
  - `source` (`file` or `mic`)
  - `inputFileName`
  - `inputFileBytes` (file bytes)
  - `chunkIndex`, `mimeType`, `inputChunkBytes` (microphone chunk path)
  - `language`, `sampleRate`, `channels`, `chunkDurationMs`, `sampleCount` (debug + ASR config)

Microphone capture path:
- Web Audio PCM capture (`float32`) on desktop
- chunked in app, encoded to WAV PCM16 mono
- sent to local worker (`local_gpu`/`local_cpu`) or server adapter (`azure_server`)

Rust Core (`src-tauri`)
- writes file bytes into session `raw/worker_input_*`
- writes microphone chunk bytes into session `raw/mic_chunks/chunk_*`
- runs Python worker command:
  - `python -m asr_worker_python.worker ...`
  - executable is resolved from `LUDO_PYTHON_PATH` or falls back to `python`
- reads stdout JSON lines
- parses only provider-neutral transcript events
- returns `events[]` to frontend

Python Worker (`services/asr-worker-python`)
- accepts CLI args for:
  - mode `file`
  - mode `mic_chunk`
- emits normalized JSON-line `TranscriptEvent` objects
- local backends (`local_gpu`, `local_cpu`) produce file-transcription event flow
- microphone path performs real faster-whisper inference and emits per-chunk progressive `interim`/`final` events
- current implementation invokes one worker process per microphone chunk (Phase 1 simplification)
- `azure_server` is handled via server adapter boundary on frontend (Azure gateway contract), not by local worker

Server ASR Adapter (`azure_server`)
- frontend uses provider-neutral server ASR abstraction
- Azure-specific server response payloads are normalized in adapter layer
- normalized output is emitted as provider-neutral `TranscriptEvent` stream
- diagnostics cover config, auth, endpoint, and connectivity failures

## Event Contract

All layers exchange only shared provider-neutral `TranscriptEvent` shapes from `@ludo/transcript-schema`.

Not allowed in this boundary:
- Azure SDK payload schemas
- Python-internal transport envelopes
- provider-specific response objects in UI state

## Persistence

After event replay, frontend calls `write_session_artifacts` to persist:
- `session.json`
- `events.jsonl`
- `transcript.md`

under `sessions/<sessionId>/` in app-local data.
