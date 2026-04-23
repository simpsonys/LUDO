# Codex Prompt — Phase 5 MCP Integration

```text
Implement Phase 5 for the realtime ASR workspace.

Goal:
Introduce MCP-backed tools into the agent pipeline.

Initial MCP tools:
1. Drive upload tool
2. glossary lookup tool
3. transcript search tool

Architecture requirements:
- keep MCP out of raw audio / ASR path
- agent consumes final transcript/session data, then optionally calls MCP tools
- document tool contracts clearly
- structure code so MCP can be disabled without breaking transcription
- Azure remains just a server-ASR provider, not the tool orchestration layer

Deliverables:
1. MCP client integration layer
2. tool abstractions
3. stub or example MCP server implementations
4. architecture documentation showing where MCP sits in the flow
5. UI hooks for MCP-backed actions where appropriate

Acceptance criteria:
- at least one agent workflow successfully uses MCP tools
- MCP can be turned off cleanly
- architecture remains decoupled

Out of scope:
- giant generic MCP marketplace
- arbitrary automation unrelated to transcript workflows
```