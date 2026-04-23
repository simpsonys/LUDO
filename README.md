# LUDO
Listen. Understand. Distill. Organize.

LUDO is a cross-platform realtime ASR workspace scaffold.

Current desktop status (early Phase 1):
- Windows desktop first
- Tauri v2 + React + TypeScript + Vite client
- provider-neutral shared transcript schema package (`@ludo/transcript-schema`)
- backend abstraction modes:
  - `local_gpu`
  - `local_cpu`
  - `azure_server`
- file transcription-first vertical slice (Python worker invocation for local backends)
- real desktop microphone capture (PCM-oriented) with chunked faster-whisper transcription events
- azure-first server ASR adapter boundary (`azure_server`) for file and microphone chunk flow
- native session artifact writer via Tauri command:
  - `session.json`
  - `events.jsonl`
  - `transcript/transcript.md`

## Monorepo Layout

```text
apps/client-tauri               Desktop client (Tauri v2 + React)
packages/transcript-schema      Shared provider-neutral transcript contract
packages/shared-types           Compatibility re-export package
services/asr-worker-python      Local ASR worker scaffold (stub)
docs/                           PRD, architecture, phases, event schema
```

Worker IPC boundary is documented in:
- [`docs/WORKER_IPC.md`](./docs/WORKER_IPC.md)

## Prerequisites

- Node.js 20+
- pnpm 9+ (tested with pnpm 10)
- Rust stable toolchain
- Tauri v2 system prerequisites for Windows
- Python 3.11+ (for `services/asr-worker-python`)
- optional: `LUDO_PYTHON_PATH` env var to point to a specific Python executable

Install Python worker dependencies:

```bash
python -m pip install -e ./services/asr-worker-python
python -m pip install -e ./services/asr-server-python
```

## Install

```bash
pnpm install
```

If `pnpm` is not available in your shell, run:

```bash
corepack pnpm install
```

## Run (Web UI only)

```bash
pnpm dev:web
```

## Run (Desktop Tauri)

```bash
pnpm dev:desktop
```

## Build Frontend

```bash
pnpm build:web
```

## Azure Server Adapter Setup

Azure server backend is now meaningful through a provider-abstracted server adapter boundary.
It expects an Azure-first ASR gateway endpoint and normalizes returned provider payloads into
the shared provider-neutral `TranscriptEvent` contract.

1. copy example env file:

```bash
cp apps/client-tauri/.env.example apps/client-tauri/.env
```

2. set at least:
   - `VITE_LUDO_SERVER_ASR_BASE_URL`

3. optional:
   - `VITE_LUDO_SERVER_ASR_API_KEY`
   - custom endpoint paths for file and microphone chunk routes

Default gateway paths:
- `/v1/asr/azure/file-transcriptions`
- `/v1/asr/azure/microphone-chunks`

Start the local Azure-first gateway server (default `127.0.0.1:8080`):

```bash
set LUDO_AZURE_SPEECH_KEY=<your_key>
set LUDO_AZURE_SPEECH_REGION=<your_region>
pnpm dev:asr-server
```

## Phase 1 Vertical Slice

In the desktop app:
1. choose backend mode
2. pick a file
3. click `Transcribe File (Phase 1)`
4. review interim/final transcript events
5. confirm write result paths for `session.json`, `events.jsonl`, `transcript.md`
6. click `Start Microphone` for real desktop microphone capture and stop when done

Session files are written under the app-local data directory in:
`.../sessions/<sessionId>/`

## Current Scope

Included:
- file-first transcription event pipeline
- backend selection UI
- provider-neutral event model
- local session artifact writing

Not included yet:
- production-grade microphone streaming transport (current path runs one Python process per chunk)
- production-grade file ASR path (file path is still staged worker analysis)
- in-app direct Azure SDK integration (desktop uses Azure-first server adapter boundary instead)
- Android implementation
- MCP
- RAG
- Google Drive sync

## Architecture Note

LUDO is Azure-first for future server ASR, but Azure-specific payload shapes are intentionally excluded from core transcript event types.
