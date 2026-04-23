# Codex Prompt — Phase 2 System Audio + Azure Server + Android Thin Client

```text
Implement Phase 2 for the realtime ASR workspace.

Current architecture:
- Tauri v2 + React + TypeScript frontend
- Rust native core
- Python local ASR worker on desktop
- Azure-first server ASR path for Android and desktop fallback

Scope:
A. Windows desktop
- add system audio capture
- keep microphone and file source support
- normalize all sources into the same transcript event pipeline
- add Azure server fallback backend path

B. Android
- add Android client target under the same product architecture
- Android should use Azure-backed server ASR
- audio captured on Android microphone is streamed to a server endpoint
- transcript events stream back to client UI

Requirements:
1. keep shared transcript event schema unchanged or evolve it compatibly
2. reuse transcript rendering UI logic where possible
3. add source selector for:
   - mic
   - system
   - file
4. add backend selector with Azure server option
5. keep Azure-specific payloads isolated behind an adapter
6. document reconnect/offline behavior

Acceptance criteria:
- Windows system audio path exists and feeds transcript pipeline
- Android client can display Azure-backed server transcript events
- desktop can switch to Azure server fallback
- transcript UI behavior is similar across desktop/mobile

Out of scope:
- RAG
- MCP
- full Drive sync
- deep meeting artifact generation
```