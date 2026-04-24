import type { TranscriptEvent } from "@ludo/transcript-schema";
import type {
  MicrophoneChunkTranscriptionRequest,
} from "./pythonWorkerClient";
import type { ServerAsrAdapter, ServerAsrFileRequest } from "./serverAsrAdapter";

const DEFAULT_FILE_ENDPOINT = "/v1/asr/azure/file-transcriptions";
const DEFAULT_MIC_CHUNK_ENDPOINT = "/v1/asr/azure/microphone-chunks";

interface NormalizeContext {
  sessionId: string;
  segmentPrefix: string;
  baseOffsetMs: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function pickBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") {
        return true;
      }
      if (normalized === "false" || normalized === "0") {
        return false;
      }
    }
  }

  return undefined;
}

function normalizeErrorPrefix(message: string, fatal: boolean): Error {
  const severity = fatal ? "fatal" : "transient";
  return new Error(`[azure_server][${severity}] ${message}`);
}

function resolveServerConfig(): {
  baseUrl: string;
  apiKey?: string;
  fileEndpoint: string;
  micChunkEndpoint: string;
  timeoutMs: number;
} {
  const baseUrl = import.meta.env.VITE_LUDO_SERVER_ASR_BASE_URL?.trim();
  if (!baseUrl) {
    throw normalizeErrorPrefix(
      "Azure server ASR base URL is not configured. Set VITE_LUDO_SERVER_ASR_BASE_URL.",
      true,
    );
  }

  const apiKey = import.meta.env.VITE_LUDO_SERVER_ASR_API_KEY?.trim();
  const fileEndpoint =
    import.meta.env.VITE_LUDO_AZURE_SERVER_FILE_PATH?.trim() || DEFAULT_FILE_ENDPOINT;
  const micChunkEndpoint =
    import.meta.env.VITE_LUDO_AZURE_SERVER_MIC_CHUNK_PATH?.trim() || DEFAULT_MIC_CHUNK_ENDPOINT;

  const timeoutRaw = import.meta.env.VITE_LUDO_SERVER_ASR_TIMEOUT_MS;
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 20_000;
  const safeTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs >= 1_000 ? Math.floor(timeoutMs) : 20_000;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: apiKey || undefined,
    fileEndpoint,
    micChunkEndpoint,
    timeoutMs: safeTimeoutMs,
  };
}

function joinEndpoint(baseUrl: string, endpoint: string): string {
  return `${baseUrl}/${endpoint.replace(/^\/+/, "")}`;
}

function extractNormalizedItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  const root = asRecord(payload);
  if (!root) {
    return [];
  }

  const candidateKeys = [
    "events",
    "segments",
    "results",
    "items",
    "recognitions",
    "hypotheses",
  ];

  for (const key of candidateKeys) {
    const candidate = root[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  const nestedData = asRecord(root.data);
  if (nestedData) {
    for (const key of candidateKeys) {
      const candidate = nestedData[key];
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }
  }

  if (typeof root.text === "string" && root.text.trim().length > 0) {
    return [root];
  }

  return [];
}

function classifyAzureResultKind(record: Record<string, unknown>): "interim" | "final" | "error" {
  const kindRaw = pickString(record, [
    "kind",
    "type",
    "eventType",
    "resultType",
    "reason",
    "recognitionStatus",
  ]);
  const isFinal = pickBoolean(record, ["isFinal", "final"]);

  const kind = kindRaw?.toLowerCase() ?? "";
  if (kind.includes("error")) {
    return "error";
  }

  if (
    isFinal === true ||
    kind.includes("final") ||
    kind.includes("recognized") ||
    kind.includes("recognised")
  ) {
    return "final";
  }

  if (
    isFinal === false ||
    kind.includes("partial") ||
    kind.includes("interim") ||
    kind.includes("recognizing") ||
    kind.includes("recognising")
  ) {
    return "interim";
  }

  return "final";
}

function normalizeTiming(
  record: Record<string, unknown>,
  baseOffsetMs: number,
): { startMs?: number; endMs?: number } {
  const startRaw = pickNumber(record, ["startMs", "offsetMs", "offset", "start", "audioOffsetMs"]);
  const endRaw = pickNumber(record, ["endMs", "end", "stopMs"]);
  const durationRaw = pickNumber(record, ["durationMs", "duration"]);

  const startMs = startRaw !== undefined ? Math.max(0, Math.round(startRaw)) + baseOffsetMs : undefined;
  if (endRaw !== undefined) {
    return {
      startMs,
      endMs: Math.max(0, Math.round(endRaw)) + baseOffsetMs,
    };
  }

  if (startMs !== undefined && durationRaw !== undefined) {
    return {
      startMs,
      endMs: startMs + Math.max(0, Math.round(durationRaw)),
    };
  }

  return {
    startMs,
    endMs: undefined,
  };
}

function normalizeAzurePayload(
  payload: unknown,
  context: NormalizeContext,
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const items = extractNormalizedItems(payload);

  items.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) {
      return;
    }

    const text =
      pickString(record, ["text", "displayText", "transcript", "utterance", "lexicalText"]) ??
      (() => {
        const nBest = record.nBest;
        if (!Array.isArray(nBest) || nBest.length === 0) {
          return undefined;
        }
        const first = asRecord(nBest[0]);
        if (!first) {
          return undefined;
        }
        return pickString(first, ["display", "displayText", "lexical", "text"]);
      })();

    const message = pickString(record, ["message", "error", "detail", "errorMessage"]);
    const segmentId =
      pickString(record, ["segmentId", "id", "resultId"]) ??
      `${context.segmentPrefix}-${index + 1}`;

    const resultKind = classifyAzureResultKind(record);
    const timing = normalizeTiming(record, context.baseOffsetMs);

    if (resultKind === "error") {
      if (message) {
        events.push({
          type: "error",
          sessionId: context.sessionId,
          at: Date.now(),
          message: `[azure_server] ${message}`,
        });
      }
      return;
    }

    if (!text || text.trim().length === 0) {
      return;
    }

    if (resultKind === "interim") {
      events.push({
        type: "interim",
        sessionId: context.sessionId,
        segmentId,
        text,
        startMs: timing.startMs,
        endMs: timing.endMs,
      });
      return;
    }

    events.push({
      type: "final",
      sessionId: context.sessionId,
      segmentId,
      text,
      startMs: timing.startMs,
      endMs: timing.endMs,
    });
  });

  if (events.length > 0) {
    return events;
  }

  const root = asRecord(payload);
  const topLevelMessage = root
    ? pickString(root, ["message", "error", "detail", "errorMessage"])
    : undefined;
  if (topLevelMessage) {
    return [
      {
        type: "error",
        sessionId: context.sessionId,
        at: Date.now(),
        message: `[azure_server] ${topLevelMessage}`,
      },
    ];
  }

  return [];
}

async function parseResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      message: text,
    };
  }
}

function mapResponseError(
  response: Response,
  payload: unknown,
  endpoint: string,
): Error {
  const payloadRecord = asRecord(payload);
  const payloadMessage = payloadRecord
    ? pickString(payloadRecord, ["message", "error", "detail", "errorMessage"])
    : undefined;

  const prefix = `Azure server request failed (${response.status}) on ${endpoint}`;
  const bodyDetail = payloadMessage ? `: ${payloadMessage}` : "";
  const baseMessage = `${prefix}${bodyDetail}`;

  if (response.status === 401 || response.status === 403) {
    return normalizeErrorPrefix(
      `${baseMessage}. Check Azure server auth/token configuration.`,
      true,
    );
  }

  if (response.status === 400 || response.status === 404) {
    return normalizeErrorPrefix(
      `${baseMessage}. Check Azure server endpoint path and request contract.`,
      true,
    );
  }

  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return normalizeErrorPrefix(`${baseMessage}. Server may be temporarily unavailable.`, false);
  }

  return normalizeErrorPrefix(baseMessage, true);
}

async function postFormData(
  endpoint: string,
  formData: FormData,
  config: ReturnType<typeof resolveServerConfig>,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers["x-api-key"] = config.apiKey;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: formData,
      signal: controller.signal,
    });

    const payload = await parseResponsePayload(response);
    if (!response.ok) {
      throw mapResponseError(response, payload, endpoint);
    }

    return payload;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        throw normalizeErrorPrefix(
          `Azure server request timed out after ${config.timeoutMs}ms (${endpoint}).`,
          false,
        );
      }

      if (error.message.includes("[azure_server]")) {
        throw error;
      }
    }

    throw normalizeErrorPrefix(
      `Azure server request could not be completed (${endpoint}): ${String(error)}`,
      false,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

function createSessionStartEnvelope(
  session: ServerAsrFileRequest["session"],
): TranscriptEvent[] {
  const now = Date.now();
  return [
    {
      type: "session_started",
      sessionId: session.sessionId,
      at: now,
      source: session.source,
      backend: "azure_server",
    },
    {
      type: "backend_state",
      sessionId: session.sessionId,
      at: now + 50,
      state: "starting",
      detail: "azure_server adapter initializing",
    },
    {
      type: "backend_state",
      sessionId: session.sessionId,
      at: now + 90,
      state: "running",
      detail: "azure_server request in progress",
    },
    {
      type: "speech_start",
      sessionId: session.sessionId,
      at: now + 110,
    },
  ];
}

export function createAzureServerAdapter(): ServerAsrAdapter {
  return {
    provider: "azure",
    validateConfig() {
      resolveServerConfig();
    },
    async transcribeFile(request) {
      const config = resolveServerConfig();
      const endpoint = joinEndpoint(config.baseUrl, config.fileEndpoint);
      const formData = new FormData();
      formData.append("file", request.file, request.file.name);
      formData.append("sessionId", request.session.sessionId);
      formData.append("source", request.session.source);
      formData.append("language", request.session.language);
      formData.append("backend", request.session.backend);
      formData.append("provider", "azure");

      const payload = await postFormData(endpoint, formData, config);
      const normalized = normalizeAzurePayload(payload, {
        sessionId: request.session.sessionId,
        segmentPrefix: "azure-file-seg",
        baseOffsetMs: 0,
      });

      const events: TranscriptEvent[] = [...createSessionStartEnvelope(request.session), ...normalized];
      const hasError = normalized.some((event) => event.type === "error");

      if (hasError) {
        events.push({
          type: "backend_state",
          sessionId: request.session.sessionId,
          at: Date.now(),
          state: "error",
          detail: "azure_server file transcription failed",
        });
      } else {
        events.push({
          type: "speech_end",
          sessionId: request.session.sessionId,
          at: Date.now(),
        });
        events.push({
          type: "backend_state",
          sessionId: request.session.sessionId,
          at: Date.now() + 20,
          state: "completed",
          detail: "azure_server file transcription completed",
        });
      }

      return {
        events,
        workerInputPath: `azure://file/${request.session.sessionId}`,
      };
    },

    async transcribeMicrophoneChunk(request: MicrophoneChunkTranscriptionRequest) {
      const config = resolveServerConfig();
      const endpoint = joinEndpoint(config.baseUrl, config.micChunkEndpoint);
      const formData = new FormData();
      const chunkBytes = new Uint8Array(request.inputChunkBytes);
      const blob = new Blob([chunkBytes], {
        type: request.mimeType || "audio/wav;codec=pcm_s16le",
      });

      formData.append("audio", blob, `chunk_${request.chunkIndex.toString().padStart(5, "0")}.wav`);
      formData.append("sessionId", request.session.sessionId);
      formData.append("chunkIndex", String(request.chunkIndex));
      formData.append("sampleRate", String(request.sampleRate));
      formData.append("channels", String(request.channels));
      formData.append("chunkDurationMs", String(request.chunkDurationMs));
      formData.append("sampleCount", String(request.sampleCount));
      formData.append("language", request.language);
      formData.append("source", request.source);
      formData.append("backend", request.backend);
      formData.append("provider", "azure");

      const payload = await postFormData(endpoint, formData, config);
      const baseOffsetMs = Math.max(0, request.chunkDurationMs * Math.max(request.chunkIndex - 1, 0));
      const normalized = normalizeAzurePayload(payload, {
        sessionId: request.session.sessionId,
        segmentPrefix: `azure-mic-seg-${request.chunkIndex.toString().padStart(5, "0")}`,
        baseOffsetMs,
      });

      const events: TranscriptEvent[] = [
        {
          type: "backend_state",
          sessionId: request.session.sessionId,
          at: Date.now(),
          state: "running",
          detail:
            `azure_server chunk=${request.chunkIndex} ` +
            `sr=${request.sampleRate} ch=${request.channels} lang=${request.language}`,
        },
      ];

      if (normalized.length === 0) {
        events.push({
          type: "backend_state",
          sessionId: request.session.sessionId,
          at: Date.now() + 15,
          state: "running",
          detail: `azure_server chunk=${request.chunkIndex} returned no transcript items`,
        });
      } else {
        events.push(...normalized);
      }

      return {
        events,
        workerInputPath: `azure://mic/${request.session.sessionId}/${request.chunkIndex}`,
      };
    },
  };
}
