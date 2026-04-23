import { invoke } from "@tauri-apps/api/core";
import type { SessionRecord, TranscriptEvent } from "@ludo/transcript-schema";

interface RunPythonFileTranscriptionRequest {
  session: SessionRecord;
  backend: SessionRecord["backend"];
  source: SessionRecord["source"];
  inputFileName: string;
  inputFileBytes: number[];
}

interface RunPythonFileTranscriptionResponse {
  events: TranscriptEvent[];
  workerInputPath: string;
}

export interface MicrophoneChunkTranscriptionRequest {
  session: SessionRecord;
  backend: SessionRecord["backend"];
  source: SessionRecord["source"];
  language: SessionRecord["language"];
  chunkIndex: number;
  sampleRate: number;
  channels: number;
  chunkDurationMs: number;
  sampleCount: number;
  mimeType?: string;
  inputChunkBytes: number[];
}

interface RunPythonMicrophoneChunkResponse {
  events: TranscriptEvent[];
  workerInputPath: string;
}

interface StartPythonMicrophoneWorkerRequest {
  session: SessionRecord;
  backend: SessionRecord["backend"];
  source: SessionRecord["source"];
  language: SessionRecord["language"];
}

interface StartPythonMicrophoneWorkerResponse {
  backend: SessionRecord["backend"];
  model: string;
  device: string;
  computeType: string;
  workerStartupMs: number;
  modelLoadMs: number;
}

interface ProcessPythonMicrophoneChunkResponse {
  events: TranscriptEvent[];
  workerInputPath: string;
  processingLatencyMs: number;
  firstChunkLatencyMs?: number;
  backend: SessionRecord["backend"];
  device: string;
  computeType: string;
}

interface StopPythonMicrophoneWorkerRequest {
  session: SessionRecord;
}

interface StopPythonMicrophoneWorkerResponse {
  stopped: boolean;
  detail: string;
}

export interface WorkerRunResult {
  events: TranscriptEvent[];
  workerInputPath: string;
}

export interface PersistentWorkerReadyInfo {
  backend: SessionRecord["backend"];
  model: string;
  device: string;
  computeType: string;
  workerStartupMs: number;
  modelLoadMs: number;
}

export interface PersistentWorkerRunResult extends WorkerRunResult {
  processingLatencyMs: number;
  firstChunkLatencyMs?: number;
  backend: SessionRecord["backend"];
  device: string;
  computeType: string;
}

export interface PersistentWorkerStopResult {
  stopped: boolean;
  detail: string;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke?: unknown;
    };
    __TAURI__?: {
      core?: {
        invoke?: unknown;
      };
    };
  }
}

function resolveGlobalInvoke():
  | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>)
  | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const candidate = window.__TAURI__?.core?.invoke;
  if (typeof candidate === "function") {
    return candidate as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  }

  return undefined;
}

function hasInternalsInvokeBridge(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return typeof window.__TAURI_INTERNALS__?.invoke === "function";
}

function createBridgeUnavailableError(command: string): Error {
  const hasWindow = typeof window !== "undefined";
  const bridgeInvoke = hasWindow ? window.__TAURI_INTERNALS__?.invoke : undefined;
  const globalInvoke = hasWindow ? window.__TAURI__?.core?.invoke : undefined;

  console.error("[LUDO][tauri] invoke bridge unavailable", {
    command,
    hasWindow,
    hasInternals: hasWindow && "__TAURI_INTERNALS__" in window,
    internalsInvokeType: typeof bridgeInvoke,
    hasGlobalTauri: hasWindow && "__TAURI__" in window,
    globalInvokeType: typeof globalInvoke,
  });

  return new Error(
    `Tauri IPC bridge is unavailable for command '${command}'. Run this path in desktop Tauri runtime (pnpm dev:desktop).`,
  );
}

async function invokeTauriCommand<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  const hasInternals = hasInternalsInvokeBridge();
  const fallbackInvoke = resolveGlobalInvoke();

  if (!hasInternals && !fallbackInvoke) {
    throw createBridgeUnavailableError(command);
  }

  if (!hasInternals && fallbackInvoke) {
    return (await fallbackInvoke(command, args)) as T;
  }

  try {
    return await invoke<T>(command, args);
  } catch (primaryError) {
    if (fallbackInvoke) {
      try {
        console.warn("[LUDO][tauri] falling back to window.__TAURI__.core.invoke", {
          command,
          primaryError: String(primaryError),
        });
        return (await fallbackInvoke(command, args)) as T;
      } catch (fallbackError) {
        throw new Error(
          `Tauri command '${command}' failed via API invoke and global fallback. primary=${String(primaryError)} fallback=${String(fallbackError)}`,
        );
      }
    }

    throw primaryError;
  }
}

export async function runPythonFileTranscription(
  request: RunPythonFileTranscriptionRequest,
): Promise<WorkerRunResult> {
  const response = await invokeTauriCommand<RunPythonFileTranscriptionResponse>(
    "run_python_file_transcription",
    {
      request,
    },
  );

  return {
    events: response.events,
    workerInputPath: response.workerInputPath,
  };
}

export async function runPythonMicrophoneChunkTranscription(
  request: MicrophoneChunkTranscriptionRequest,
): Promise<WorkerRunResult> {
  const response = await invokeTauriCommand<RunPythonMicrophoneChunkResponse>(
    "run_python_microphone_chunk_transcription",
    {
      request,
    },
  );

  return {
    events: response.events,
    workerInputPath: response.workerInputPath,
  };
}

export async function startPythonMicrophoneWorker(
  request: StartPythonMicrophoneWorkerRequest,
): Promise<PersistentWorkerReadyInfo> {
  const response = await invokeTauriCommand<StartPythonMicrophoneWorkerResponse>(
    "start_python_microphone_worker",
    {
      request,
    },
  );

  return {
    backend: response.backend,
    model: response.model,
    device: response.device,
    computeType: response.computeType,
    workerStartupMs: response.workerStartupMs,
    modelLoadMs: response.modelLoadMs,
  };
}

export async function processPythonMicrophoneChunkTranscription(
  request: MicrophoneChunkTranscriptionRequest,
): Promise<PersistentWorkerRunResult> {
  const response = await invokeTauriCommand<ProcessPythonMicrophoneChunkResponse>(
    "process_python_microphone_chunk_transcription",
    {
      request,
    },
  );

  return {
    events: response.events,
    workerInputPath: response.workerInputPath,
    processingLatencyMs: response.processingLatencyMs,
    firstChunkLatencyMs: response.firstChunkLatencyMs,
    backend: response.backend,
    device: response.device,
    computeType: response.computeType,
  };
}

export async function stopPythonMicrophoneWorker(
  request: StopPythonMicrophoneWorkerRequest,
): Promise<PersistentWorkerStopResult> {
  const response = await invokeTauriCommand<StopPythonMicrophoneWorkerResponse>(
    "stop_python_microphone_worker",
    {
      request,
    },
  );

  return {
    stopped: response.stopped,
    detail: response.detail,
  };
}
