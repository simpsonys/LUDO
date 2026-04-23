# Codex Prompt — Phase 3 Agent Artifact Generation

```text
Implement Phase 3 for the realtime ASR workspace.

Goal:
Turn transcript into useful Markdown artifacts.

Inputs:
- final transcript segments
- session metadata
- source/backend/provider metadata
- user mode:
  - meeting
  - lecture
  - casual

Outputs:
1. meeting_minutes.md
2. action_items.md
3. explain_like_im_new.md
4. artifact_manifest.json

Requirements:
1. keep prompts in external files under a prompts directory
2. support Korean output while preserving English technical terms
3. make artifact generation modular
4. do not mix agent logic into raw audio path
5. persist artifacts into the session folder
6. wire the UI so the user can trigger generation per session
7. keep this pipeline independent from Azure-specific transcript payloads

Acceptance criteria:
- user can click buttons to generate artifacts
- Markdown outputs are saved locally
- prompts are editable without touching core code
- artifact pipeline is isolated enough for later MCP integration

Out of scope:
- MCP tools
- full RAG
- Google Drive upload
```