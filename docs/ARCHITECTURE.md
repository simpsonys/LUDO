# Architecture — LUDO
> Listen. Understand. Distill. Organize.

## 1. High-Level Architecture

```text
[Tauri App: React UI]
   ├─ Session Screen
   ├─ Transcript Screen
   ├─ Artifact Screen
   ├─ Q&A / RAG Screen
   └─ Settings / Sync Screen

[Tauri Rust Core]
   ├─ Audio Source Manager
   ├─ Event Bus
   ├─ Session Manager
   ├─ Local Persistence
   ├─ Backend Adapter Bridge
   └─ Sync / Drive Bridge

[ASR Layer]
   ├─ Local ASR Worker (Python + faster-whisper)
   ├─ Server ASR Client
   └─ Azure Provider Adapter

[Agent Layer]
   ├─ Minutes Agent
   ├─ Action Item Agent
   ├─ Explain Agent
   ├─ RAG Orchestrator
   └─ MCP Tool Client

[Storage Layer]
   ├─ raw audio
   ├─ event log (jsonl)
   ├─ markdown artifacts
   ├─ metadata db
   └─ vector index

[External]
   ├─ Google Drive API
   ├─ Azure AI Speech
   ├─ LLM / agent endpoints
   └─ MCP servers
```

---

## 2. Technology Stack

### Frontend
- Tauri v2
- React
- TypeScript
- Vite

### Native Core
- Rust
- Tauri commands/events
- platform adapters for capture and filesystem/session orchestration

### Local ASR
- Python worker
- faster-whisper
- local GPU on Windows
- local CPU fallback

### Server Side
- Azure-first ASR adapter
- ASR gateway/service abstraction
- Agent orchestration service
- RAG service or shared library

### Persistence
- session folders on disk
- SQLite for metadata
- local vector index or service abstraction

---

## 3. Design Principle: Azure-First, Not Azure-Coupled

### Rule
Azure is the **default server ASR provider**, but app core types and flow must remain provider-neutral.

### Implications
- do not expose Azure SDK payload shapes in UI state
- do not make session schema Azure-specific
- normalize provider events at adapter boundary
- allow future provider swap without rewriting transcript UI or storage format

---

## 4. Layer Responsibilities

## 4.1 UI Layer
Responsibilities:
- render transcript
- show backend/source/session status
- let user choose:
  - source
  - backend
  - model
  - language
- display artifacts
- display sync state
- run Q&A UI

Should not:
- do heavy ASR work
- know Azure SDK event shape
- directly talk to every external service

## 4.2 Rust Core
Responsibilities:
- session lifecycle
- event routing
- platform-specific adapters
- local storage coordination
- backend health checks
- bridge between UI and worker/services

Should not:
- embed large ASR model logic directly in early phases
- mix agent reasoning logic with audio capture
- depend on provider-specific transcript semantics

## 4.3 ASR Layer
Responsibilities:
- receive audio frames or files
- produce transcript events:
  - interim
  - final
  - status/error
- expose health/version/model capabilities
- normalize provider events

Should not:
- generate minutes
- upload to Drive
- own RAG logic

## 4.4 Agent Layer
Responsibilities:
- consume final transcript chunks or session outputs
- produce:
  - minutes
  - action items
  - easy explanation
- orchestrate RAG
- call MCP tools

Should not:
- sit in raw audio path
- be required for baseline transcription

## 4.5 Storage Layer
Responsibilities:
- raw session persistence
- append-only event log
- artifact storage
- local metadata
- vector indexing

## 4.6 Sync Layer
Responsibilities:
- upload/download
- track sync state
- handle retry
- reconcile session manifests

---

## 5. Transcript Event Model

## 5.1 App Core Event Types

```ts
type TranscriptEvent =
  | { type: "session_started"; sessionId: string; at: number; source: "mic" | "system" | "file"; backend: "local_gpu" | "local_cpu" | "azure_server" }
  | { type: "backend_state"; sessionId: string; at: number; state: "idle" | "starting" | "running" | "completed" | "error"; detail?: string }
  | { type: "speech_start"; sessionId: string; at: number }
  | { type: "interim"; sessionId: string; segmentId: string; text: string; startMs?: number; endMs?: number }
  | { type: "final"; sessionId: string; segmentId: string; text: string; startMs?: number; endMs?: number }
  | { type: "speech_end"; sessionId: string; at: number }
  | { type: "artifact_generated"; sessionId: string; artifact: string; path: string }
  | { type: "sync_status"; sessionId: string; state: "queued" | "running" | "done" | "error"; detail?: string }
  | { type: "error"; sessionId: string; message: string };
```

### Why event-driven
This keeps the system decoupled:
- UI can subscribe
- storage can append
- agent can consume final chunks
- sync can observe artifact generation
- Azure provider output can be normalized once

---

## 6. Backend Selection Model

## 6.1 Desktop
Desktop backend options:
- Local GPU
- Local CPU
- Azure Server

### Resolution flow
1. user selects backend
2. app checks health
3. if unavailable, UI shows actionable error
4. optional fallback proposal shown

### Recommended UX
- default to Local GPU when healthy
- offer Local CPU if CUDA fails
- offer Azure Server as final fallback

## 6.2 Android
Primary backend:
- Azure Server

Optional later:
- additional providers behind same server abstraction

---

## 7. Audio Capture Architecture

## 7.1 Sources
- Microphone
- System Audio (Windows)
- File input

## 7.2 Abstraction
```text
AudioSource
 ├─ MicSource
 ├─ SystemLoopbackSource
 └─ FileSource
```

All sources should emit normalized PCM frames into the same pipeline.

---

## 8. ASR Provider Adapter Architecture

## 8.1 Adapter abstraction
```text
AsrBackend
 ├─ LocalWhisperBackend
 └─ ServerAsrBackend
      └─ AzureSpeechAdapter
```

## 8.2 AzureSpeechAdapter responsibilities
- convert app audio frames/request format to Azure request format
- map Azure partial/final events into app core `TranscriptEvent`
- translate Azure errors into provider-neutral errors
- attach provider metadata for diagnostics only

## 8.3 Design rule
Only the adapter layer knows Azure-specific event shape.

---

## 9. Session Storage Model

## 9.1 On-disk structure
```text
sessions/
  {sessionId}/
    session.json
    events.jsonl
    raw/
      capture.wav
    transcript/
      transcript.md
    artifacts/
      meeting_minutes.md
      action_items.md
      explain_like_im_new.md
    rag/
      index_manifest.json
```

## 9.2 Why JSONL event log
- crash recovery
- replay
- debugging
- later analytics
- provider-neutral reprocessing

---

## 10. RAG Architecture

## 10.1 Inputs
- transcript final segments
- generated artifacts
- future uploaded docs / Drive docs
- glossary

## 10.2 Pipeline
1. chunk transcript/artifacts
2. generate embeddings
3. store vectors + metadata
4. query retrieves relevant chunks
5. answer generated with references

## 10.3 Metadata
- sessionId
- source
- backend
- provider
- artifact type
- timestamp range
- title / tag
- chunk index

---

## 11. Agent + MCP Architecture

## 11.1 Agent pipeline
```text
final transcript chunks
  -> artifact generation agent
  -> rag orchestrator
  -> optional tool calls via MCP
  -> saved markdown/json outputs
```

## 11.2 MCP tool examples
- Drive upload tool
- glossary lookup tool
- transcript search tool
- task export tool (later)

## 11.3 Why MCP here
MCP gives a structured way to let the agent use tools without coupling raw ASR to every integration.

---

## 12. Google Drive Sync Architecture

## 12.1 Sync unit
The sync unit is a **session**.

## 12.2 Upload targets
- session.json
- events.jsonl
- transcript.md
- generated artifacts
- raw audio if enabled
- manifest/index files

## 12.3 Strategy
- desktop: upload on session end or manual sync
- mobile: queue + retry
- large files: resumable upload
- maintain sync manifest locally

---

## 13. Failure Handling

## 13.1 Local GPU failure
- show diagnostics
- allow CPU fallback
- allow Azure Server fallback
- preserve session

## 13.2 Azure server failure
- retry / reconnect
- mark transcript gaps if needed
- preserve captured audio
- preserve provider-neutral event stream as much as possible

## 13.3 Sync failure
- local session stays authoritative until sync completes
- retry queue persisted

---

## 14. Design Rules

1. ASR must work without Agent
2. Agent must work without MCP
3. MCP must never sit in raw audio path
4. every session produces structured local artifacts first
5. external sync happens after local persistence
6. desktop and mobile share event schema
7. backend-specific logic must stay behind adapters
8. Azure is the default server provider, not the core domain model
