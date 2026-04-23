import type { BackendMode, SessionRecord } from "@ludo/transcript-schema";
import type {
  MicrophoneChunkTranscriptionRequest,
  WorkerRunResult,
} from "./pythonWorkerClient";
import { createAzureServerAdapter } from "./azureServerAdapter";

export interface ServerAsrFileRequest {
  session: SessionRecord;
  file: File;
}

export interface ServerAsrAdapter {
  provider: "azure";
  validateConfig: () => void;
  transcribeFile: (request: ServerAsrFileRequest) => Promise<WorkerRunResult>;
  transcribeMicrophoneChunk: (
    request: MicrophoneChunkTranscriptionRequest,
  ) => Promise<WorkerRunResult>;
}

export function createServerAsrAdapter(mode: BackendMode): ServerAsrAdapter {
  if (mode !== "azure_server") {
    throw new Error(
      `Server ASR adapter was requested for backend '${mode}', but only 'azure_server' is supported.`,
    );
  }

  return createAzureServerAdapter();
}
