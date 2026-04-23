# EVENT_SCHEMA — LUDO
> Listen. Understand. Distill. Organize.

Shared package: `@ludo/transcript-schema`

## Design Rules

1. Transcript events are provider-neutral.
2. Azure-specific payloads stay in adapter boundaries.
3. UI and storage consume only normalized `TranscriptEvent`.
4. Desktop and Android reuse this contract.

## Core Enums

```ts
type SessionSource = "mic" | "system" | "file";
type BackendMode = "local_gpu" | "local_cpu" | "azure_server";
type BackendRuntimeState = "idle" | "starting" | "running" | "completed" | "error";
```

## Transcript Event Union

```ts
type TranscriptEvent =
  | { type: "session_started"; sessionId: string; at: number; source: SessionSource; backend: BackendMode }
  | { type: "backend_state"; sessionId: string; at: number; state: BackendRuntimeState; detail?: string }
  | { type: "speech_start"; sessionId: string; at: number }
  | { type: "interim"; sessionId: string; segmentId: string; text: string; startMs?: number; endMs?: number }
  | { type: "final"; sessionId: string; segmentId: string; text: string; startMs?: number; endMs?: number }
  | { type: "speech_end"; sessionId: string; at: number }
  | { type: "artifact_generated"; sessionId: string; artifact: string; path: string }
  | { type: "sync_status"; sessionId: string; state: "queued" | "running" | "done" | "error"; detail?: string }
  | { type: "error"; sessionId: string; message: string };
```

## Adapter Boundary Rule

Allowed in adapter layer only:
- Azure SDK request/response payloads
- provider-specific confidence/latency wire fields
- transport-specific reconnect metadata

Not allowed in core schema:
- Azure event payload objects in app event union
- Azure wire-level offset/duration keys
- provider-native transport envelopes in UI/storage state

## Session Snapshot Contract

```ts
interface SessionSnapshot {
  session: SessionRecord;
  events: TranscriptEvent[];
}
```

This keeps session replay, persistence, and UI rendering decoupled from provider-specific payload formats.
