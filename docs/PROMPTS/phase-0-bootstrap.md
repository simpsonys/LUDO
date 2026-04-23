# Codex Prompt — Phase 0 Bootstrap (Azure-First)

```text
You are implementing Phase 0 for LUDO, a cross-platform realtime ASR workspace.

Project goals:
- Windows desktop + Android support
- Windows uses local ASR first (GPU/CPU selectable)
- Android uses Azure-first server ASR
- desktop can later fallback to Azure server ASR
- transcript can later generate meeting minutes, action items, easy explanation, and RAG Q&A
- Google Drive sync will be added later
- MCP will be added later for tool-backed agent workflows

Current phase scope:
- planning and scaffold only
- no real ASR yet
- no Android implementation yet
- no MCP yet
- no RAG yet

Requirements:
1. create a monorepo scaffold
2. use Tauri v2 + React + TypeScript + Vite for the client app
3. prepare Rust backend structure in src-tauri
4. prepare a Python worker service folder for local ASR
5. create shared transcript event types
6. create documentation files:
   - PRD.md
   - ARCHITECTURE.md
   - PHASES.md
   - EVENT_SCHEMA.md
7. create scripts to run desktop development mode
8. create a minimal mock transcript UI using fake events
9. make the architecture Azure-first for server ASR but provider-abstracted

Deliverables:
- runnable scaffold
- mock transcript events rendered in the UI
- clean folder structure
- README with setup instructions

Acceptance criteria:
- workspace installs cleanly
- Tauri app launches
- fake transcript stream is shown in UI
- documentation files exist and match architecture
- server-ASR abstraction does not leak Azure-specific types into core app schema

Out of scope:
- real microphone capture
- real ASR
- Android build
- Google Drive
- MCP
- RAG
```