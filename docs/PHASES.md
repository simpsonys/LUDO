# Phase Plan — LUDO
> Listen. Understand. Distill. Organize.

## Phase 0 — Planning & Contract Freeze

### Objective
Freeze the architecture and shared contracts before building.

### Deliverables
- `PRD.md`
- `ARCHITECTURE.md`
- `EVENT_SCHEMA.md`
- `PHASES.md`
- prompt pack for Codex

### Tasks
- define event schema
- define session storage schema
- define backend abstraction
- define Azure-first server adapter abstraction
- define artifact output contract
- define out-of-scope list

### Acceptance Criteria
- engineering can begin without re-litigating the architecture every day
- event schema is agreed for desktop and Android
- local vs Azure server backend behavior is documented
- provider-specific payload leakage is explicitly prohibited

---

## Phase 1 — Windows Desktop MVP

### Objective
Build a Windows desktop MVP with local ASR and live transcript.

### Scope
- Tauri desktop app
- source:
  - microphone
  - file
- backend:
  - local GPU
  - local CPU
- model selection:
  - medium
  - large-v3-turbo
  - large-v3
- live transcript UI
- save transcript.md + events.jsonl + session.json

### Out of Scope
- Android
- system audio
- Azure path implementation
- Drive sync
- RAG
- MCP
- agent artifact generation

### Acceptance Criteria
- app launches
- microphone transcription works
- file transcription works
- backend selection works
- artifacts saved locally
- missing CUDA runtime shows clean error

---

## Phase 2 — System Audio + Azure Server Path + Android Thin Client

### Objective
Add Windows system audio capture and Android Azure-server client path.

### Scope
- Windows system audio capture
- Android microphone streaming
- Azure-backed server ASR client path
- desktop Azure fallback path
- shared transcript UI behavior
- reconnect/offline notes

### Out of Scope
- full RAG
- MCP
- Drive sync hardening

### Acceptance Criteria
- desktop can capture lecture audio from system output
- Android can stream mic audio to Azure-backed server ASR
- desktop can switch to Azure server backend
- transcript events render consistently across desktop/mobile

---

## Phase 3 — Agent Artifact Generation

### Objective
Turn transcript into useful outputs.

### Scope
- meeting minutes generator
- action items generator
- easy explanation generator
- artifact manifest
- prompt files externalized

### Out of Scope
- MCP integration
- full transcript-centric RAG
- Drive upload

### Acceptance Criteria
- user can generate Markdown artifacts from a session
- Korean output is natural while preserving English technical terms
- artifacts are persisted into session folder

---

## Phase 4 — RAG & Q&A

### Objective
Let the user ask questions against transcript and related materials.

### Scope
- chunking and embedding
- metadata-aware retrieval
- Q&A UI
- answer with references
- ingest transcript + generated artifacts

### Out of Scope
- Drive-doc ingestion hardening
- complex multi-session memory policies
- enterprise retrieval features

### Acceptance Criteria
- user can ask questions against a session
- answers cite chunk/time references
- retrieval path is testable and modular

---

## Phase 5 — MCP Integration

### Objective
Introduce real tool-backed agent workflows.

### Scope
- Drive upload tool
- glossary lookup tool
- transcript search tool
- MCP-aware agent orchestration layer
- tool contract documentation

### Out of Scope
- giant MCP ecosystem
- arbitrary automation sprawl
- raw audio path tool invocation

### Acceptance Criteria
- agent can call at least 3 MCP tools
- MCP remains isolated from raw ASR path
- architecture docs clearly show MCP flow

---

## Phase 6 — Google Drive Sync Hardening

### Objective
Make Drive sync production-usable.

### Scope
- OAuth/auth flow
- resumable upload for large files
- retry queue
- sync status UI
- manifest reconciliation

### Acceptance Criteria
- artifacts reliably upload
- failed sync can be retried
- session remains usable locally before remote sync succeeds

---

## Phase 7 — Hardening & Packaging

### Objective
Make it stable enough for daily use.

### Scope
- model cache UI
- GPU diagnostics
- Azure backend diagnostics
- reconnect logic
- session recovery
- better logs
- export/import
- packaging and release docs

### Acceptance Criteria
- stable long-session behavior
- actionable diagnostics
- releaseable desktop package
- Android testable build

---

## Recommended Execution Order

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
8. Phase 7
