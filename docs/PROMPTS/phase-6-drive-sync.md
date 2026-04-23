# Codex Prompt — Phase 6 Google Drive Sync Hardening

```text
Implement Phase 6 for the realtime ASR workspace.

Goal:
Make Google Drive sync usable and reliable.

Scope:
- session-based folder creation
- upload of transcript/artifacts/session metadata
- optional raw audio upload
- resumable upload for large files
- sync status tracking
- retry queue

Requirements:
1. preserve local-first behavior
2. failed uploads must not corrupt local session state
3. maintain a sync manifest
4. show sync status in the UI
5. support deferred sync for Android or offline states
6. keep Google Drive sync separate from Azure ASR provider logic

Acceptance criteria:
- user can sync a session to Drive
- failed sync can be retried
- sync status is visible
- session stays usable locally whether sync succeeds or not

Out of scope:
- enterprise Drive admin features
- multi-account org controls
```