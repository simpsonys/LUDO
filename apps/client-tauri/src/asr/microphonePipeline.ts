import { invoke } from "@tauri-apps/api/core";
import type { BackendMode, SessionRecord, TranscriptEvent } from "@ludo/transcript-schema";
import type { TranscriptSink } from "./backendAdapter";
import type { StreamHandle } from "./mockPipeline";
import {
  startPythonMicrophoneWorker,
  stopPythonMicrophoneWorker,
  processPythonMicrophoneChunkTranscription,
  runPythonMicrophoneChunkTranscription,
  type MicrophoneChunkTranscriptionRequest,
  type PersistentWorkerRunResult,
  type WorkerRunResult,
} from "./pythonWorkerClient";

interface MicrophoneSessionRequest {
  session: SessionRecord;
  backend: BackendMode;
}

export type MicrophoneChunkTranscriber = (
  request: MicrophoneChunkTranscriptionRequest,
) => Promise<WorkerRunResult>;

interface StartMicrophoneChunkedSessionOptions {
  transcribeChunk?: MicrophoneChunkTranscriber;
}

const CHUNK_DURATION_MS = 3000;
const MIN_FLUSH_MS = 800;
const MAX_CONSECUTIVE_CHUNK_ERRORS = 3;
const PERSISTENT_WORKER_BACKENDS: BackendMode[] = ["local_gpu", "local_cpu"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapMicrophoneError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Microphone capture failed due to an unknown error.";
  }

  const name = (error as DOMException).name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone permission denied. Allow microphone access in system and browser settings.";
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone input device was found.";
  }

  if (name === "NotReadableError") {
    return "Microphone is busy or unavailable. Close other recording apps and retry.";
  }

  return `Microphone capture failed: ${error.message}`;
}

function clampSample(sample: number): number {
  if (sample > 1) {
    return 1;
  }

  if (sample < -1) {
    return -1;
  }

  return sample;
}

function encodeMonoPcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const totalSize = 44 + dataSize;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const normalized = clampSample(samples[i]);
    const pcm16 = normalized < 0 ? normalized * 32768 : normalized * 32767;
    view.setInt16(offset, pcm16, true);
    offset += bytesPerSample;
  }

  return new Uint8Array(buffer);
}

function mergeFloat32Chunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

async function replayProgressively(events: TranscriptEvent[], sink: TranscriptSink): Promise<void> {
  for (const event of events) {
    sink(event);
    await sleep(70);
  }
}

function classifyChunkFailure(message: string): "fatal" | "transient" {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("[azure_server][fatal]") ||
    normalized.includes("runtime dll discovery failed") ||
    normalized.includes("tauri ipc bridge is unavailable") ||
    normalized.includes("unsupported backend") ||
    normalized.includes("unsupported language") ||
    normalized.includes("input_chunk_bytes is empty")
  ) {
    return "fatal";
  }

  if (
    normalized.includes("status -1073740791") ||
    normalized.includes("status -1073741819") ||
    normalized.includes("status -1073740940")
  ) {
    return "transient";
  }

  return "transient";
}

export async function startMicrophoneChunkedSession(
  request: MicrophoneSessionRequest,
  sink: TranscriptSink,
  options: StartMicrophoneChunkedSessionOptions = {},
): Promise<StreamHandle> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Microphone capture is not supported in this runtime.");
  }

  const mediaStream = await navigator.mediaDevices
    .getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
    .catch((error: unknown) => {
      throw new Error(mapMicrophoneError(error));
    });

  return startAudioChunkedSessionImpl(mediaStream, request, sink, options, "mic");
}

export async function startSystemAudioChunkedSession(
  request: MicrophoneSessionRequest,
  sink: TranscriptSink,
  options: StartMicrophoneChunkedSessionOptions = {},
): Promise<StreamHandle> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    throw new Error("System audio capture is not supported in this runtime.");
  }

  const mediaStream = await navigator.mediaDevices
    .getDisplayMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: true, // video is required for getDisplayMedia, but we will ignore the video tracks
    })
    .catch((error: unknown) => {
      throw new Error(`System audio capture failed: ${error instanceof Error ? error.message : String(error)}`);
    });

  const audioTracks = mediaStream.getAudioTracks();
  if (audioTracks.length === 0) {
    mediaStream.getTracks().forEach((track) => track.stop());
    throw new Error("No audio track was shared. Please make sure to check 'Share audio' when selecting the screen/window.");
  }

  return startAudioChunkedSessionImpl(mediaStream, request, sink, options, "system");
}

async function startAudioChunkedSessionImpl(
  mediaStream: MediaStream,
  request: MicrophoneSessionRequest,
  sink: TranscriptSink,
  options: StartMicrophoneChunkedSessionOptions,
  sourceLabel: "mic" | "system"
): Promise<StreamHandle> {
  const audioContext = new AudioContext();
  await audioContext.resume();
  const sourceNode = audioContext.createMediaStreamSource(mediaStream);
  const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  const mutedNode = audioContext.createGain();
  mutedNode.gain.value = 0;

  sourceNode.connect(processorNode);
  processorNode.connect(mutedNode);
  mutedNode.connect(audioContext.destination);

  const sessionId = request.session.sessionId;
  const sampleRate = Math.round(audioContext.sampleRate);
  const channels = 1;
  const chunkTargetSamples = Math.max(1024, Math.floor((sampleRate * CHUNK_DURATION_MS) / 1000));

  console.info(`[LUDO][${sourceLabel}] capture-start`, {
    sampleRate,
    channels,
    chunkDurationMs: CHUNK_DURATION_MS,
    backend: request.backend,
    language: request.session.language,
  });

  const startedAt = Date.now();
  sink({
    type: "session_started",
    sessionId,
    at: startedAt,
    source: request.session.source,
    backend: request.backend,
  });
  sink({
    type: "backend_state",
    sessionId,
    at: startedAt + 40,
    state: "starting",
    detail: `pcm capture initializing sr=${sampleRate} ch=${channels} chunkMs=${CHUNK_DURATION_MS} lang=${request.session.language} backend=${request.backend}`,
  });

  const supportsPersistentWorker = PERSISTENT_WORKER_BACKENDS.includes(request.backend);
  const transcribeChunkFallback = options.transcribeChunk ?? runPythonMicrophoneChunkTranscription;
  let persistentWorkerActive = false;

  const stopPersistentWorker = async (reason: string): Promise<void> => {
    if (!persistentWorkerActive) {
      return;
    }

    persistentWorkerActive = false;
    try {
      const stopResult = await stopPythonMicrophoneWorker({
        session: request.session,
      });
      console.info(`[LUDO][${sourceLabel}] persistent-worker-stop`, {
        sessionId,
        backend: request.backend,
        reason,
        stopped: stopResult.stopped,
        detail: stopResult.detail,
      });
    } catch (error) {
      console.warn(`[LUDO][${sourceLabel}] persistent-worker-stop failed`, {
        sessionId,
        backend: request.backend,
        reason,
        error: String(error),
      });
    }
  };

  if (supportsPersistentWorker) {
    try {
      const readyInfo = await startPythonMicrophoneWorker({
        session: request.session,
        backend: request.backend,
        source: request.session.source,
        language: request.session.language,
      });
      persistentWorkerActive = true;

      console.info(`[LUDO][${sourceLabel}] persistent-worker-ready`, {
        sessionId,
        backend: request.backend,
        language: request.session.language,
        model: readyInfo.model,
        device: readyInfo.device,
        computeType: readyInfo.computeType,
        startupMs: readyInfo.workerStartupMs,
        modelLoadMs: readyInfo.modelLoadMs,
      });
      sink({
        type: "backend_state",
        sessionId,
        at: Date.now(),
        state: "running",
        detail:
          `persistent worker ready model=${readyInfo.model} device=${readyInfo.device} ` +
          `compute=${readyInfo.computeType} startupMs=${readyInfo.workerStartupMs} modelLoadMs=${readyInfo.modelLoadMs}`,
      });
    } catch (error) {
      console.warn(`[LUDO][${sourceLabel}] persistent-worker-start failed; fallback to per-chunk worker spawn`, {
        sessionId,
        backend: request.backend,
        error: String(error),
      });
      sink({
        type: "backend_state",
        sessionId,
        at: Date.now(),
        state: "error",
        detail: "persistent worker start failed; using per-chunk fallback path",
      });
    }
  }

  sink({
    type: "backend_state",
    sessionId,
    at: startedAt + 70,
    state: "running",
    detail: "microphone capture active",
  });
  sink({
    type: "speech_start",
    sessionId,
    at: startedAt + 80,
  });

  let chunkIndex = 0;
  let closing = false;
  let encounteredError = false;
  let fatalErrorEmitted = false;
  let consecutiveChunkErrors = 0;
  let doneSettled = false;
  let doneResolve: (state: "completed" | "stopped") => void = () => undefined;

  const done = new Promise<"completed" | "stopped">((resolve) => {
    doneResolve = resolve;
  });

  const settle = (state: "completed" | "stopped") => {
    if (doneSettled) {
      return;
    }
    doneSettled = true;
    doneResolve(state);
  };

  const pendingFrames: Float32Array[] = [];
  let pendingSampleCount = 0;

  const fullSessionFrames: Float32Array[] = [];

  let processingQueue: Promise<void> = Promise.resolve();

  const failAndStopCapture = (error: unknown) => {
    if (fatalErrorEmitted) {
      return;
    }
    fatalErrorEmitted = true;
    encounteredError = true;

    const message = `Microphone chunk processing failed: ${String(error)}`;
    sink({
      type: "error",
      sessionId,
      message,
    });
    sink({
      type: "backend_state",
      sessionId,
      at: Date.now(),
      state: "error",
      detail: "microphone capture stopped after worker failure",
    });

    closing = true;
    teardownNodes();
    void stopPersistentWorker("capture failure");
    settle("completed");
  };

  const submitChunk = (samples: Float32Array, explicitDurationMs?: number) => {
    const activeChunkIndex = ++chunkIndex;
    const chunkDurationMs =
      explicitDurationMs ?? Math.max(1, Math.round((samples.length / sampleRate) * 1000));

    console.debug(`[LUDO][${sourceLabel}] chunk-submit`, {
      chunkIndex: activeChunkIndex,
      sampleRate,
      channels,
      chunkDurationMs,
      sampleCount: samples.length,
      backend: request.backend,
      language: request.session.language,
    });

    processingQueue = processingQueue
      .then(async () => {
        const wavBytes = encodeMonoPcm16Wav(samples, sampleRate);
        const chunkRequest: MicrophoneChunkTranscriptionRequest = {
          session: request.session,
          backend: request.backend,
          source: request.session.source,
          language: request.session.language,
          chunkIndex: activeChunkIndex,
          sampleRate,
          channels,
          chunkDurationMs,
          sampleCount: samples.length,
          mimeType: "audio/wav;codec=pcm_s16le",
          inputChunkBytes: Array.from(wavBytes),
        };

        const runChunk = async (): Promise<WorkerRunResult | PersistentWorkerRunResult> => {
          if (!persistentWorkerActive) {
            return transcribeChunkFallback(chunkRequest);
          }

          try {
            return await processPythonMicrophoneChunkTranscription(chunkRequest);
          } catch (error) {
            sink({
              type: "backend_state",
              sessionId,
              at: Date.now(),
              state: "error",
              detail: `persistent worker failed on chunk=${activeChunkIndex}; restarting`,
            });

            await stopPersistentWorker("recover after chunk failure");

            try {
              const readyInfo = await startPythonMicrophoneWorker({
                session: request.session,
                backend: request.backend,
                source: request.session.source,
                language: request.session.language,
              });
              persistentWorkerActive = true;
              console.info(`[LUDO][${sourceLabel}] persistent-worker-recovered`, {
                sessionId,
                backend: request.backend,
                model: readyInfo.model,
                device: readyInfo.device,
                computeType: readyInfo.computeType,
                startupMs: readyInfo.workerStartupMs,
                modelLoadMs: readyInfo.modelLoadMs,
              });
              sink({
                type: "backend_state",
                sessionId,
                at: Date.now(),
                state: "running",
                detail:
                  `persistent worker recovered model=${readyInfo.model} device=${readyInfo.device} ` +
                  `compute=${readyInfo.computeType}`,
              });
              return await processPythonMicrophoneChunkTranscription(chunkRequest);
            } catch (restartError) {
              persistentWorkerActive = false;
              sink({
                type: "backend_state",
                sessionId,
                at: Date.now(),
                state: "error",
                detail: "persistent worker recovery failed; falling back to per-chunk worker spawn",
              });
              console.warn(`[LUDO][${sourceLabel}] persistent-worker-recovery failed; fallback`, {
                sessionId,
                backend: request.backend,
                error: String(restartError),
                initialError: String(error),
              });
              return transcribeChunkFallback(chunkRequest);
            }
          }
        };

        const result = await runChunk();

        if ("processingLatencyMs" in result) {
          console.debug(`[LUDO][${sourceLabel}] persistent-worker-chunk`, {
            sessionId,
            backend: result.backend,
            chunkIndex: activeChunkIndex,
            processingLatencyMs: result.processingLatencyMs,
            firstChunkLatencyMs: result.firstChunkLatencyMs,
            device: result.device,
            computeType: result.computeType,
          });
          sink({
            type: "backend_state",
            sessionId,
            at: Date.now(),
            state: "running",
            detail:
              `chunk=${activeChunkIndex} processingMs=${result.processingLatencyMs} ` +
              `firstChunkMs=${result.firstChunkLatencyMs ?? "n/a"} device=${result.device} compute=${result.computeType}`,
          });
        }

        await replayProgressively(result.events, sink);
        consecutiveChunkErrors = 0;
      })
      .catch((error) => {
        const message = String(error);
        const failureType = classifyChunkFailure(message);
        consecutiveChunkErrors += 1;

        if (failureType === "fatal" || consecutiveChunkErrors >= MAX_CONSECUTIVE_CHUNK_ERRORS) {
          failAndStopCapture(error);
          return;
        }

        sink({
          type: "backend_state",
          sessionId,
          at: Date.now(),
          state: "error",
          detail: `transient chunk failure on chunk=${activeChunkIndex}; continuing (${consecutiveChunkErrors}/${MAX_CONSECUTIVE_CHUNK_ERRORS})`,
        });
        console.warn(`[LUDO][${sourceLabel}] transient chunk failure, continuing`, {
          chunkIndex: activeChunkIndex,
          backend: request.backend,
          consecutiveChunkErrors,
          error: message,
        });
      });
  };

  const flushChunk = (force = false) => {
    if (pendingSampleCount === 0) {
      return;
    }

    const durationMs = Math.round((pendingSampleCount / sampleRate) * 1000);
    if (!force && durationMs < MIN_FLUSH_MS) {
      return;
    }

    const merged = mergeFloat32Chunks(pendingFrames);
    pendingFrames.length = 0;
    pendingSampleCount = 0;
    submitChunk(merged, durationMs);
  };

  processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
    if (closing) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input.length);
    copy.set(input);
    pendingFrames.push(copy);
    fullSessionFrames.push(copy);
    pendingSampleCount += copy.length;

    if (pendingSampleCount >= chunkTargetSamples) {
      flushChunk();
    }
  };

  const teardownNodes = () => {
    processorNode.onaudioprocess = null;
    try {
      sourceNode.disconnect();
    } catch {
      // no-op
    }
    try {
      processorNode.disconnect();
    } catch {
      // no-op
    }
    try {
      mutedNode.disconnect();
    } catch {
      // no-op
    }
    mediaStream.getTracks().forEach((track) => track.stop());
    void audioContext.close();
  };

  return {
    stop() {
      if (closing) {
        return;
      }
      closing = true;

      flushChunk(true);
      teardownNodes();

      void processingQueue.finally(() => {
        void (async () => {
          try {
            if (fullSessionFrames.length > 0) {
              const merged = mergeFloat32Chunks(fullSessionFrames);
              const wavBytes = encodeMonoPcm16Wav(merged, sampleRate);
              
              if (typeof window !== "undefined" && window.__TAURI_INTERNALS__?.invoke) {
                await invoke("save_microphone_recording", {
                  request: {
                    sessionId,
                    wavBytes: Array.from(wavBytes),
                  },
                });
                console.info(`[LUDO][${sourceLabel}] saved full session recording`);
              }
            }
          } catch (err) {
            console.error(`[LUDO][${sourceLabel}] failed to save full session recording`, err);
          }

          await stopPersistentWorker("session stop");

          if (encounteredError) {
            settle("completed");
            return;
          }

          sink({
            type: "speech_end",
            sessionId,
            at: Date.now(),
          });
          sink({
            type: "backend_state",
            sessionId,
            at: Date.now() + 20,
            state: "completed",
            detail: "microphone capture stopped",
          });

          settle("completed");
        })();
      });
    },
    done,
  };
}
