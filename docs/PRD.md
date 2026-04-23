# PRD — LUDO
> Listen. Understand. Distill. Organize.

## 1. Product Summary

LUDO is a cross-platform realtime ASR workspace for:

- **Windows Desktop**
  - local GPU ASR on RTX 5090
  - local CPU fallback
  - Azure-first server ASR fallback
  - microphone input
  - system audio capture
  - file transcription
- **Android**
  - microphone capture
  - Azure-first server ASR backend
  - live transcript UI

The product is not just a recorder. It must turn transcript into useful knowledge artifacts:

1. meeting minutes
2. action items
3. detailed easy explanation in Markdown
4. RAG-based Q&A over transcript and related materials

The product must also support Google Drive sync and serve as a learning vehicle for **Agent** and **MCP** architecture.

---

## 2. Goals

### Primary goals
- Realtime transcript UI for lecture/meeting listening workflows
- Backend selection in UI:
  - Local GPU
  - Local CPU
  - Azure Server
- Generate post-session artifacts from transcript
- Build transcript-centric RAG Q&A
- Sync artifacts and raw/session data to Google Drive
- Use Agent/MCP in a real project, not as a toy demo

### Secondary goals
- Reusable architecture across Windows and Android
- Strong local-first desktop workflow
- Structured artifacts and session logs
- Future support for glossary correction, diarization, task export
- Keep server-ASR provider abstracted behind an adapter boundary

---

## 3. Non-goals

Not in the initial scope:

- perfect diarization in v1
- fully offline Android Whisper execution
- video conferencing platform integrations in v1
- multi-user collaborative editing in v1
- enterprise auth / org admin features in v1
- provider-specific transcript schema leaking into app core types

---

## 4. Target Users

### Primary user
A technical power user who:
- listens to lectures, meetings, demos, or tutorials
- wants live transcript + post-processing
- wants to search and ask questions later
- prefers local GPU on desktop where available

### Secondary user
A mobile-first user who:
- records or monitors a live talk on Android
- uses server ASR for live transcript
- syncs results to Drive for later desktop review

---

## 5. Core Use Cases

### UC-1: Windows Desktop live lecture listening
- user selects `System Audio`
- user selects `Local GPU`
- transcript appears in realtime
- after stop, app generates:
  - transcript.md
  - meeting_minutes.md
  - action_items.md
  - explain_like_im_new.md

### UC-2: Windows Desktop microphone meeting capture
- user selects `Microphone`
- user selects `Local GPU` or `Local CPU`
- transcript is shown live
- user opens Q&A tab and asks questions against same session

### UC-3: Windows Desktop Azure fallback
- local CUDA/runtime is unavailable
- user switches backend to `Azure Server`
- transcript continues through server ASR path without changing UI semantics

### UC-4: Android live capture
- user selects `Microphone`
- user uses `Azure Server`
- transcript appears live
- session syncs to Drive later or immediately

### UC-5: File-based transcription
- user opens audio/video file
- chooses backend and model
- app outputs transcript and metadata
- user optionally generates summaries and RAG index

### UC-6: Agent-assisted post-processing
- user clicks `Generate Minutes`
- agent produces structured minutes in Markdown
- user clicks `Extract Action Items`
- agent returns checklist style artifact

### UC-7: Transcript-centric RAG
- user asks: “이 강의에서 RAG chunking은 왜 중요한가?”
- app retrieves transcript chunks + related docs
- app answers with references to sections/timestamps

---

## 6. Functional Requirements

## 6.1 Session & Sources
- support sources:
  - microphone
  - system audio (Windows)
  - uploaded file
- session start/stop/pause
- session metadata:
  - title
  - tags
  - source type
  - backend type
  - provider type
  - language
  - timestamps

## 6.2 ASR
- selectable backends:
  - Local GPU
  - Local CPU
  - Azure Server
- selectable models for local backend:
  - medium
  - large-v3-turbo
  - large-v3
- selectable language:
  - ko
  - en
  - auto
- realtime transcript states:
  - interim
  - final
- app core transcript events must be provider-neutral
- Azure-specific payloads must be normalized in adapter layer

## 6.3 Transcript UI
- live scrolling transcript
- current partial/interim line
- session timer
- source indicator
- backend indicator
- provider indicator
- error status display
- optional confidence / diagnostics later

## 6.4 Artifact Generation
Generate the following:
- transcript.md
- meeting_minutes.md
- action_items.md
- explain_like_im_new.md
- session_manifest.json

## 6.5 RAG / Q&A
- ingest transcript chunks
- ingest generated markdown artifacts
- allow future ingestion of Drive documents
- query UI
- answer with references to transcript sections/timestamps

## 6.6 Google Drive Sync
- create session folder structure
- upload artifacts
- upload raw audio if enabled
- support retry / delayed sync
- track sync status

## 6.7 Agent / MCP
- Agent pipeline consumes final transcript chunks or completed sessions
- MCP-backed tools initially include:
  - Drive upload tool
  - glossary lookup tool
  - transcript search tool

---

## 7. Non-Functional Requirements

### Performance
- desktop live transcript latency should feel near-realtime
- UI must remain responsive while ASR runs
- long sessions must not corrupt artifacts
- Android server path must degrade gracefully on unstable network

### Reliability
- crash-safe local session storage
- append-only transcript event log
- resumable sync strategy for network failures
- provider adapter failures must not corrupt session model

### Maintainability
- clear module separation:
  - capture
  - ASR
  - transcript state
  - provider adapter
  - agent
  - storage
  - RAG
  - sync

### Portability
- common frontend/domain logic across Windows and Android
- backend-specific adapters where required

---

## 8. Success Criteria

### Phase 1 success
- Windows desktop app runs
- microphone input works
- file transcription works
- local backend selection works
- transcript saved as Markdown + JSONL

### Phase 2 success
- Windows system audio capture works
- Android thin client streams to Azure-backed server ASR
- desktop Azure fallback path works
- transcript UI reused across platforms

### Phase 3 success
- one-click generation of:
  - meeting minutes
  - action items
  - easy explanation

### Phase 4 success
- transcript-centric Q&A works with references

### Phase 5 success
- at least 3 MCP tools integrated into Agent flow

---

## 9. Risks

- Windows system audio capture complexity
- CUDA/cuDNN runtime management
- streaming stability across desktop/mobile
- Google Drive auth and sync edge cases
- Azure quota / throttling / network behavior
- cost/latency tradeoffs in agent calls

---

## 10. Recommended Build Order

1. Desktop MVP (local-first)
2. System audio capture
3. Android thin client + Azure server path
4. Agent artifact generation
5. RAG
6. MCP integration
7. Drive sync hardening
