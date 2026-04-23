# Codex Prompt — Phase 1 Desktop MVP (Local-First)

```text
Implement Phase 1 for the cross-platform realtime ASR workspace.

Stack constraints:
- Tauri v2
- React + TypeScript + Vite
- Rust native core
- Python worker for local ASR using faster-whisper

Scope:
- Windows desktop only
- source types:
  - microphone
  - uploaded file
- backend options:
  - local GPU
  - local CPU
- model options:
  - medium
  - large-v3-turbo
  - large-v3
- language options:
  - ko
  - en
  - auto
- live transcript UI with interim and final states
- local session storage:
  - session.json
  - events.jsonl
  - transcript.md

Requirements:
1. implement shared transcript event schema
2. implement Tauri commands/events needed for session lifecycle
3. implement Python worker IPC interface
4. support file transcription first if microphone live mode is harder
5. render transcript incrementally in the UI
6. add clear error reporting for CUDA runtime issues
7. keep code modular for later Android/Azure server ASR support
8. do not hardcode Azure provider types into the transcript model

Acceptance criteria:
- desktop app launches
- user can transcribe a file
- user can start microphone transcription or at least a mock/live partial path if capture layer is incomplete
- transcript appears incrementally
- output artifacts are written locally
- backend and model can be selected in the UI

Out of scope:
- Android
- system audio
- Azure implementation
- Google Drive sync
- RAG
- MCP
- post-session minutes generation
```