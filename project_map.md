# LUDO — Project Map
> Listen. Understand. Distill. Organize.
> Stack: Tauri v2 · React · TypeScript · Rust · Python (faster-whisper)

**Last updated:** 2026-04-23  
**Use this file first.** Read this file before scanning the repo.  
**Update rule:** Whenever major files, directories, architecture, or execution flow change, update this file immediately.

This file is the **architecture navigation index** for LUDO.  
For setup and end-user run instructions, see `README.md`.

---

## Project Overview

LUDO is a local-first Windows desktop ASR workspace.

The current working loop is:

1. User selects audio source (`mic`, `file`) and backend (`local_gpu`, `local_cpu`, `azure_server`)
2. Audio is captured in the frontend/Tauri context
3. Audio or file payload is routed through a provider-neutral ASR path
4. Rust command handlers bridge the frontend to Python worker processes
5. Python worker performs faster-whisper inference for local ASR paths
6. JSON transcript events are returned and normalized into provider-neutral `TranscriptEvent` objects
7. React session state is updated
8. Session artifacts are written to disk as:
   - `session.json`
   - `events.jsonl`
   - `transcript.md`

**Important:** Core transcript/session/event types must remain **provider-neutral**.  
Provider-specific logic must stay isolated in adapter files only.

---

## Current Priorities

1. **Local ASR quality**
   - quality-first tuning for `local_gpu` / `local_cpu`
   - compute type visibility and A/B testing support
   - mic/live transcription quality improvement

2. **Microphone live path stability**
   - persistent worker flow
   - chunk handling
   - transcript latency and stability

3. **Session persistence**
   - `session.json`
   - `events.jsonl`
   - `transcript.md`

4. **Next likely implementation step**
   - Windows system audio capture

5. **Not started yet**
   - artifact generation
   - RAG / Q&A
   - MCP integration

6. **Implemented partially but currently deprioritized**
   - Azure-first server ASR path
   - local Azure-first ASR gateway server
   - Android client path

---

## Implementation Status Snapshot

### Working
- desktop Tauri runtime
- local file transcription
- microphone transcription
- Windows system audio capture (via getDisplayMedia)
- `local_cpu` ASR path
- `local_gpu` ASR path
- persistent microphone worker path
- provider-neutral transcript event flow
- session artifact writing

### Partial / Experimental
- Azure server adapter path in client
- local Azure-first ASR gateway server
- Azure backend routing in UI/state

### Not Started
- artifact generation
- RAG / Q&A
- MCP integration
- Android client implementation

---

## High-Level Architecture

```text
[React UI]
    │  selectedBackend, selectedLanguage, selectedComputeType
    │  session controls, transcript view, event log, diagnostics
    ▼
[backendAdapter.ts]
    │  local path → microphonePipeline.ts / pythonWorkerClient.ts
    │  server path → serverAsrAdapter.ts → azureServerAdapter.ts
    ▼
[Tauri IPC — invoke()]
    ▼
[lib.rs — Tauri command handlers]
    │  local worker lifecycle
    │  compute_type injection
    │  CUDA runtime DLL resolution for local_gpu
    │  session artifact writing
    ▼
[worker.py — faster-whisper]
    │  resolves model / device / compute_type
    │  performs local ASR inference
    │  emits JSON transcript events
    ▼
[lib.rs — parse worker output]
    ▼
[sessionStore.ts → applyTranscriptEvent()]
    ▼
[sessionFileWriter.ts → write_session_artifacts]
    ▼
[Disk: session.json + events.jsonl + transcript.md]
```

---

## Directory Map

```text
LUDO/
├── apps/
│   └── client-tauri/                      # Tauri desktop app (React + Rust)
│       ├── src/                           # React / TypeScript frontend
│       │   ├── App.tsx                    # Root UI component; session controls, transcript panel, status UI
│       │   ├── asr/
│       │   │   ├── backendAdapter.ts      # Top-level ASR routing; local vs server path
│       │   │   ├── microphonePipeline.ts  # Mic capture, PCM/WAV chunking, local worker lifecycle
│       │   │   ├── pythonWorkerClient.ts  # Tauri invoke wrappers for Python worker commands
│       │   │   ├── serverAsrAdapter.ts    # Provider-neutral server adapter interface
│       │   │   ├── azureServerAdapter.ts  # Azure-specific HTTP adapter + payload normalization
│       │   │   └── mockPipeline.ts        # Mock/staged transcript replay helpers
│       │   └── session/
│       │       ├── sessionStore.ts        # Session state, reducer, provider-neutral event application
│       │       ├── sessionFileWriter.ts   # Tauri write_session_artifacts command wrapper
│       │       └── sessionPersistence.ts  # localStorage/session layout helpers
│       ├── src-tauri/
│       │   └── src/
│       │       ├── lib.rs                 # Main Rust logic: Tauri commands, worker management, session writing
│       │       └── main.rs                # Entry point only
│       └── .env                           # Client-side env vars (e.g. Azure server base URL)
│
├── packages/
│   ├── transcript-schema/
│   │   └── src/index.ts                   # Canonical shared provider-neutral types
│   └── shared-types/                      # Thin wrapper / re-exports around transcript-schema
│
├── services/
│   ├── asr-worker-python/
│   │   └── src/asr_worker_python/
│   │       └── worker.py                  # Python local ASR worker; faster-whisper inference
│   └── asr-server-python/                 # Local Azure-first ASR gateway server (partial / deprioritized)
│
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── PHASES.md
│   └── PROMPTS/
│
├── README.md
├── GlobalDirectives.md
├── history.md                             # Should be maintained according to GlobalDirectives.md
├── SuggestedCommit.txt
├── package.json
├── pnpm-workspace.yaml
└── project_map.md                         # ← this file
```

---

## Core Logic Flow

### Microphone session (current primary live path)

```text
App.tsx:startMicrophoneSession()
  → createSessionRecord({ backend, language, computeType, source:"mic" })
  → createBackendAdapter(mode).startMicrophoneSession(session, sink)
      → microphonePipeline.ts:startMicrophoneChunkedSession()
          → navigator.mediaDevices.getUserMedia()
          → startPythonMicrophoneWorker() via Tauri IPC
              → lib.rs:start_python_microphone_worker
                  → resolve backend/device/compute_type
                  → resolve GPU DLL runtime paths if local_gpu
                  → spawn Python worker in mic_stream mode
                  → wait for worker ready event
          → capture PCM frames and encode/send chunk payloads
          → processPythonMicrophoneChunkTranscription() via Tauri IPC
              → lib.rs:process_python_microphone_chunk_transcription
                  → store raw chunk WAV for debugging/session raw data
                  → send transcribe request to persistent worker
                  → receive provider-neutral transcript events
          → events are replayed/applied in frontend state
  → on stop: stopPythonMicrophoneWorker()
  → finalizeRun()
      → writeSessionArtifacts()
          → lib.rs:write_session_artifacts
```

### File transcription (stable secondary path)

```text
App.tsx:startFileTranscription()
  → createSessionRecord({ source:"file", backend, language, computeType })
  → createBackendAdapter(mode).transcribeFile(request, sink)
      → pythonWorkerClient.ts:runPythonFileTranscription()
          → lib.rs:run_python_file_transcription
              → store input file under session raw directory
              → run worker in file mode
              → parse JSON transcript events
      → events replayed into session state
  → finalizeRun()
      → writeSessionArtifacts()
```

### Azure/server path (implemented partially, not current priority)

```text
App.tsx
  → createBackendAdapter("azure_server")
      → serverAsrAdapter.ts
          → azureServerAdapter.ts
              → fetch() to local Azure-first ASR gateway server
              → normalize provider payload into provider-neutral TranscriptEvent[]
```

---

## compute_type Resolution

### local_gpu
Priority order:

```text
session.computeType
  → LUDO_GPU_COMPUTE_TYPE env var
  → default "float16"
```

### local_cpu
Current behavior:

```text
device = "cpu"
compute_type = "int8"
```

No UI compute-type selector should be introduced for CPU unless there is an intentional design change.

---

## Key Files by Layer

### UI Layer

| File | Purpose |
|------|---------|
| `apps/client-tauri/src/App.tsx` | Root UI component. Session controls, backend/language/compute type selection, transcript and event log UI. |
| `apps/client-tauri/src/asr/backendAdapter.ts` | Top-level routing between local ASR and server ASR paths. |

### Native / Rust Layer

| File | Purpose |
|------|---------|
| `apps/client-tauri/src-tauri/src/lib.rs` | Main Rust ownership file. Tauri command handlers, worker lifecycle, environment injection, GPU DLL resolution, session artifact writing. |
| `apps/client-tauri/src-tauri/src/main.rs` | Entry point only. |

### Python Worker Layer

| File | Purpose |
|------|---------|
| `services/asr-worker-python/src/asr_worker_python/worker.py` | Main Python ASR worker. Handles local file and mic inference, model loading, runtime config, event emission. |

### Shared Schema / Types

| File | Purpose |
|------|---------|
| `packages/transcript-schema/src/index.ts` | Canonical provider-neutral `SessionRecord`, `TranscriptEvent`, backend/source/language types. This is the shared contract. |

### Session Persistence

| File | Purpose |
|------|---------|
| `apps/client-tauri/src/session/sessionStore.ts` | Session state shape, reducer, event application, session creation. |
| `apps/client-tauri/src/session/sessionFileWriter.ts` | Writes disk artifacts via Tauri command. |
| `apps/client-tauri/src/session/sessionPersistence.ts` | localStorage-level backup and session layout helper logic. |

### Backend / Provider Adapters

| File | Purpose |
|------|---------|
| `apps/client-tauri/src/asr/microphonePipeline.ts` | Current live mic path. Capture, chunking, worker coordination, error handling. |
| `apps/client-tauri/src/asr/pythonWorkerClient.ts` | Typed `invoke()` wrappers for Rust command calls. |
| `apps/client-tauri/src/asr/serverAsrAdapter.ts` | Provider-neutral server adapter interface / abstraction. |
| `apps/client-tauri/src/asr/azureServerAdapter.ts` | Azure-specific HTTP adapter. This is the only frontend file that should understand Azure payload structure. |
| `apps/client-tauri/src/asr/mockPipeline.ts` | Dev/test mock replay helpers. |

### Local Server Path (deprioritized but present)

| File | Purpose |
|------|---------|
| `services/asr-server-python/main.py` | Local Azure-first ASR gateway entry point (if present in repo). |
| `services/asr-server-python/pyproject.toml` | Python server package/runtime definition. |
| `services/asr-server-python/README.md` | Local server usage notes and env requirements. |

---

## Important Commands

```bash
# Run desktop Tauri app (required for Rust invoke / worker bridge)
pnpm dev:desktop

# Run React web-only dev server (no Tauri IPC; ASR worker bridge will fail)
pnpm dev:web

# Run local Azure-first ASR gateway server (if implemented in repo)
pnpm dev:asr-server

# Type-check frontend
pnpm check

# Build web assets
pnpm build:web
```

---

## Environment / Runtime Overrides

```bash
# Force a specific GPU compute type
LUDO_GPU_COMPUTE_TYPE=int8_float16 pnpm dev:desktop

# Override Python executable used by worker
LUDO_PYTHON_PATH=C:/path/to/python.exe pnpm dev:desktop

# Force a specific Whisper model
LUDO_WHISPER_MODEL=large-v3-turbo pnpm dev:desktop

# Enable VAD for mic path if supported
LUDO_MIC_VAD_FILTER=true pnpm dev:desktop

# Skip CUDA runtime probe (debug/testing only)
LUDO_DISABLE_CUDA_CHECK=1 pnpm dev:desktop
```

### Client `.env` examples

Located at:

```text
apps/client-tauri/.env
```

Example values:

```env
VITE_LUDO_SERVER_ASR_BASE_URL=http://127.0.0.1:8080
VITE_LUDO_AZURE_SERVER_FILE_PATH=/v1/asr/azure/file-transcriptions
VITE_LUDO_AZURE_SERVER_MIC_CHUNK_PATH=/v1/asr/azure/microphone-chunks
VITE_LUDO_SERVER_ASR_TIMEOUT_MS=20000
```

---

## On-Disk Session Layout

**Important:** The exact base session path is determined by the Tauri app data directory used in `lib.rs`.  
Do not hardcode `%APPDATA%` vs `%LOCALAPPDATA%` assumptions without checking the current Rust implementation.

Typical layout:

```text
sessions/{sessionId}/
    session.json
    events.jsonl
    transcript/
        transcript.md
    raw/
        worker_input_*          # file transcription input copies
        mic_chunks/
            chunk_00001.wav
            ...
        mic_debug/
            debug_chunk_00001.wav
            ...
```

---

## Known Constraints / Guardrails

1. **Provider-neutral types are mandatory**
   - `TranscriptEvent`, `SessionRecord`, and shared session state must not contain Azure-specific fields.

2. **Azure payload normalization belongs only in provider adapter files**
   - currently `azureServerAdapter.ts`

3. **Default `local_gpu` compute type is quality-first**
   - default should be `float16`
   - `int8_float16` may remain as explicit override or UI-selectable option

4. **`local_cpu` is the baseline fallback**
   - no CUDA runtime should be required for this path

5. **Persistent worker is the primary microphone path**
   - avoid reintroducing per-chunk process spawning as the main path unless guarded as fallback/debug mode

6. **Windows system audio capture is implemented via WebRTC (`getDisplayMedia`)**
   - `SessionSource = "system"` is fully hooked up

7. **Artifact generation is not implemented yet**
   - do not confuse session persistence with artifact generation

8. **RAG and MCP are not implemented yet**
   - keep transcript/event/storage layers clean for future integration

9. **Azure is present but not the current priority**
   - do not let Azure-specific concerns distort local-first architecture work

10. **Use `project_map.md` first**
    - do not scan the whole repo before narrowing the task to relevant files

---

## Files to Read First for Common Tasks

### Local ASR quality tuning
1. `services/asr-worker-python/src/asr_worker_python/worker.py`
2. `apps/client-tauri/src-tauri/src/lib.rs`
3. `apps/client-tauri/src/App.tsx`
4. `apps/client-tauri/src/asr/microphonePipeline.ts`
5. `apps/client-tauri/src/session/sessionStore.ts`

### Mic capture debugging
1. `apps/client-tauri/src/asr/microphonePipeline.ts`
2. `apps/client-tauri/src/asr/pythonWorkerClient.ts`
3. `services/asr-worker-python/src/asr_worker_python/worker.py`
4. `apps/client-tauri/src-tauri/src/lib.rs`

### Persistent worker work
1. `apps/client-tauri/src-tauri/src/lib.rs`
2. `services/asr-worker-python/src/asr_worker_python/worker.py`
3. `apps/client-tauri/src/asr/microphonePipeline.ts`

### Windows system audio capture (next likely phase)
1. `packages/transcript-schema/src/index.ts`
2. `apps/client-tauri/src/asr/microphonePipeline.ts`
3. `apps/client-tauri/src-tauri/src/lib.rs`

### Artifact generation (not started yet)
1. `apps/client-tauri/src/session/sessionStore.ts`
2. `apps/client-tauri/src/session/sessionFileWriter.ts`
3. `packages/transcript-schema/src/index.ts`

### Azure / server integration (deferred)
1. `apps/client-tauri/src/asr/azureServerAdapter.ts`
2. `apps/client-tauri/src/asr/serverAsrAdapter.ts`
3. `apps/client-tauri/src/asr/backendAdapter.ts`
4. `services/asr-server-python/`

### RAG / MCP (not started yet)
- No implementation yet. Start from `docs/PHASES.md` and `docs/ARCHITECTURE.md`.

---

## Files That Must Remain Provider-Neutral

Never add Azure-, Google-, or vendor-specific fields directly into these files:

- `packages/transcript-schema/src/index.ts`
- `apps/client-tauri/src/session/sessionStore.ts`
- `apps/client-tauri/src/session/sessionFileWriter.ts`
- `apps/client-tauri/src-tauri/src/lib.rs` session/request structs
- any shared session/event metadata written to disk

Provider-specific normalization belongs only in adapter layers.

---

## Suggested Update Rules

Update this file whenever any of the following happen:

- a new Tauri command is added in `lib.rs`
- a new file is added under `src/asr/` or `src/session/`
- a new field is added to `SessionRecord` or `TranscriptEvent`
- microphone/system/file execution flow changes materially
- Python worker gains a new mode or major capability
- on-disk session layout changes
- a new environment variable is introduced
- Windows system audio capture starts
- artifact generation starts
- RAG or MCP work begins
- Azure/server integration meaningfully changes state

Keep entries **architecture-level and task-relevant**.  
Do not turn this file into a line-by-line code index.

---

## history.md Status

According to `GlobalDirectives.md`, `history.md` should be maintained in the repo root for resumability and quota/session recovery.

Guideline:
- if `history.md` does not exist, create it before the next major task
- update it at the beginning, pause, and completion of each significant task
- archive prior history into `AIHistory/YYYYMMDD_AIHistory.md` when resetting for a new task
