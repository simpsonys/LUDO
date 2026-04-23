# Codex Prompt — Phase 4 Transcript-Centric RAG

```text
Implement Phase 4 for the realtime ASR workspace.

Goal:
Support transcript-centric Q&A over session data.

Ingestion inputs:
- transcript final segments
- meeting_minutes.md
- action_items.md
- explain_like_im_new.md

Requirements:
1. implement chunking and embedding pipeline
2. store metadata with each chunk:
   - sessionId
   - artifact type
   - timestamp range if available
   - chunk index
   - backend/provider
3. implement query API
4. implement Q&A UI
5. answers must cite transcript chunks or timestamps
6. architecture must allow future ingestion of Google Drive docs
7. retrieval pipeline must not depend on Azure-specific event payloads

Acceptance criteria:
- user can ask questions against a session
- relevant transcript/artifact chunks are retrieved
- answer includes references
- pipeline is modular and testable

Out of scope:
- full multi-user knowledge base
- Drive ingestion hardening
- MCP integration
```