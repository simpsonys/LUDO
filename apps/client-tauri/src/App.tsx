import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BackendMode, SessionLanguage, TranscriptEvent } from "@ludo/transcript-schema";
import { BACKEND_MODES, createBackendAdapter, type StreamHandle } from "./asr/backendAdapter";
import {
  loadLatestSessionSnapshot,
  planSessionLayout,
  persistSessionSnapshot,
} from "./session/sessionPersistence";
import { writeSessionArtifacts, type SessionWriteResult } from "./session/sessionFileWriter";
import {
  applyTranscriptEvent,
  createInitialSessionState,
  createSessionRecord,
  hydrateSessionState,
  toSessionSnapshot,
  type SessionState,
} from "./session/sessionStore";

function loadInitialState(): SessionState {
  const latest = loadLatestSessionSnapshot();
  if (latest) {
    return hydrateSessionState(latest);
  }

  return createInitialSessionState();
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatBytes(bytes?: number): string {
  if (!bytes || Number.isNaN(bytes)) {
    return "-";
  }

  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

function labelForBackend(mode: BackendMode): string {
  if (mode === "local_gpu") {
    return "Local GPU";
  }

  if (mode === "local_cpu") {
    return "Local CPU";
  }

  return "Azure Server";
}

function describeEvent(event: TranscriptEvent): string {
  if (event.type === "session_started") {
    return `${event.source} / ${event.backend}`;
  }

  if (event.type === "backend_state") {
    return `${event.state}${event.detail ? ` (${event.detail})` : ""}`;
  }

  if (event.type === "interim" || event.type === "final") {
    return event.text;
  }

  if (event.type === "error") {
    return event.message;
  }

  if (event.type === "sync_status") {
    return `${event.state}${event.detail ? ` (${event.detail})` : ""}`;
  }

  return "";
}

export default function App() {
  const [state, setState] = useState<SessionState>(() => loadInitialState());
  const [selectedBackend, setSelectedBackend] = useState<BackendMode>("local_gpu");
  const [selectedLanguage, setSelectedLanguage] = useState<SessionLanguage>("ko");
  const [selectedComputeType, setSelectedComputeType] = useState<string>("float16");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [actionMessage, setActionMessage] = useState<string>("Ready");
  const [writeResult, setWriteResult] = useState<SessionWriteResult | null>(null);

  const stateRef = useRef(state);
  const streamRef = useRef<StreamHandle | null>(null);
  const runRef = useRef(0);
  
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const eventsContainerRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    stateRef.current = state;
    persistSessionSnapshot(toSessionSnapshot(state));
  }, [state]);

  useEffect(() => {
    if (transcriptContainerRef.current) {
      const el = transcriptContainerRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [state.finalSegments, state.interimText]);

  useEffect(() => {
    if (eventsContainerRef.current) {
      const el = eventsContainerRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [state.events]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    const timer = setInterval(() => {
      setClock(Date.now());
    }, 400);

    return () => clearInterval(timer);
  }, [isRunning]);

  useEffect(
    () => () => {
      if (streamRef.current) {
        streamRef.current.stop();
      }
    },
    [],
  );

  const elapsedMs = useMemo(() => {
    if (!state.startedAt) {
      return 0;
    }

    const end = state.endedAt ?? clock;
    return Math.max(end - state.startedAt, 0);
  }, [state.startedAt, state.endedAt, clock]);

  const emitEvent = (event: TranscriptEvent, runId: number) => {
    if (runId !== runRef.current) {
      return;
    }

    setState((current) => {
      const next = applyTranscriptEvent(current, event);
      stateRef.current = next;
      return next;
    });

    if (event.type === "error") {
      setActionMessage(event.message);
    }

    if (event.type === "speech_end" || event.type === "error") {
      setIsRunning(false);
      streamRef.current = null;
      void finalizeRun(runId);
    }
  };

  const finalizeRun = async (runId: number) => {
    if (runId !== runRef.current) {
      return;
    }

    const snapshot = toSessionSnapshot(stateRef.current);
    const result = await writeSessionArtifacts(snapshot.session, snapshot.events);

    if (runId !== runRef.current) {
      return;
    }

    setWriteResult(result);
    setActionMessage(result.message);
  };

  const prepareRun = (next: SessionState) => {
    if (streamRef.current) {
      streamRef.current.stop();
      streamRef.current = null;
    }

    runRef.current += 1;
    stateRef.current = next;
    setState(next);
    setIsRunning(true);
    setWriteResult(null);
    setActionMessage("Transcription pipeline running...");
  };

  const startFileTranscription = () => {
    if (!selectedFile) {
      setActionMessage("Select a file first to run the file transcription path.");
      return;
    }

    const session = createSessionRecord({
      source: "file",
      backend: selectedBackend,
      language: selectedLanguage,
      computeType: selectedBackend === "local_gpu" ? selectedComputeType : undefined,
      title: `LUDO File Session - ${selectedFile.name}`,
      inputFileName: selectedFile.name,
      inputFileBytes: selectedFile.size,
    });

    const initial = createInitialSessionState(session);
    prepareRun(initial);
    const runId = runRef.current;
    const adapter = createBackendAdapter(selectedBackend);

    if (selectedBackend === "local_gpu" || selectedBackend === "local_cpu") {
      setActionMessage("Invoking Python worker for local file transcription...");
    } else {
      setActionMessage("Invoking Azure-first server ASR adapter for file transcription...");
    }

    const handle = adapter.transcribeFile(
      {
        session,
        file: selectedFile,
      },
      (event) => emitEvent(event, runId),
    );

    streamRef.current = handle;
  };

  const startMicrophoneSession = () => {
    const session = createSessionRecord({
      source: "mic",
      backend: selectedBackend,
      language: selectedLanguage,
      computeType: selectedBackend === "local_gpu" ? selectedComputeType : undefined,
      title: `LUDO Microphone Session (${labelForBackend(selectedBackend)})`,
    });

    const initial = createInitialSessionState(session);
    prepareRun(initial);
    const runId = runRef.current;
    const adapter = createBackendAdapter(selectedBackend);

    if (selectedBackend === "local_gpu" || selectedBackend === "local_cpu") {
      setActionMessage("Starting real microphone capture...");
    } else {
      setActionMessage("Starting microphone capture with Azure-first server ASR adapter...");
    }

    const handle = adapter.startMicrophoneSession(session, (event) => emitEvent(event, runId));
    streamRef.current = handle;
  };

  const startSystemAudioSession = () => {
    const session = createSessionRecord({
      source: "system",
      backend: selectedBackend,
      language: selectedLanguage,
      computeType: selectedBackend === "local_gpu" ? selectedComputeType : undefined,
      title: `LUDO System Audio Session (${labelForBackend(selectedBackend)})`,
    });

    const initial = createInitialSessionState(session);
    prepareRun(initial);
    const runId = runRef.current;
    const adapter = createBackendAdapter(selectedBackend);

    if (selectedBackend === "local_gpu" || selectedBackend === "local_cpu") {
      setActionMessage("Starting system audio capture...");
    } else {
      setActionMessage("Starting system audio capture with Azure-first server ASR adapter...");
    }

    const handle = adapter.startSystemAudioSession(session, (event) => emitEvent(event, runId));
    streamRef.current = handle;
  };

  const stopRun = async () => {
    const activeHandle = streamRef.current;
    if (!activeHandle) {
      return;
    }

    activeHandle.stop();
    streamRef.current = null;
    const runId = runRef.current;
    const doneState = await activeHandle.done;

    if (doneState === "stopped" && stateRef.current.session.status === "running") {
      emitEvent(
        {
          type: "speech_end",
          sessionId: stateRef.current.session.sessionId,
          at: Date.now(),
        },
        runId,
      );
      return;
    }

    setActionMessage("Stopping transcription...");
  };

  const newSession = () => {
    if (streamRef.current) {
      streamRef.current.stop();
      streamRef.current = null;
    }

    runRef.current += 1;
    const next = createInitialSessionState(
      createSessionRecord({
        source: "file",
        backend: selectedBackend,
        language: selectedLanguage,
      }),
    );
    stateRef.current = next;
    setState(next);
    setIsRunning(false);
    setActionMessage("Started a fresh session.");
    setWriteResult(null);
  };

  const restoreLatest = () => {
    const latest = loadLatestSessionSnapshot();
    if (!latest) {
      setActionMessage("No local snapshot found.");
      return;
    }

    const hydrated = hydrateSessionState(latest);
    runRef.current += 1;
    stateRef.current = hydrated;
    setState(hydrated);
    setIsRunning(false);
    setActionMessage("Restored latest local snapshot.");
  };

  const openPath = (path: string) => {
    void invoke("open_path", { path });
  };

  const snapshot = toSessionSnapshot(state);
  const plannedLayout = planSessionLayout(state.session.sessionId);

  return (
    <div className="app-shell">
      <header className="hero">
        <p className="label">LUDO</p>
        <h1>Listen. Understand. Distill. Organize.</h1>
        <p className="subtext">
          Phase 1 vertical slice: file and microphone transcription pipelines with provider-neutral events.
        </p>

        <div className="controls">
          <label>
            Backend Mode
            <select
              value={selectedBackend}
              onChange={(event) => setSelectedBackend(event.target.value as BackendMode)}
              disabled={isRunning}
            >
              {BACKEND_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {labelForBackend(mode)}
                </option>
              ))}
            </select>
          </label>

          <label>
            File Source
            <input
              type="file"
              onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
              disabled={isRunning}
            />
          </label>

          <label>
            Language
            <select
              value={selectedLanguage}
              onChange={(event) => setSelectedLanguage(event.target.value as SessionLanguage)}
              disabled={isRunning}
            >
              <option value="ko">Korean (ko)</option>
              <option value="auto">Auto</option>
              <option value="en">English (en)</option>
            </select>
          </label>

          {selectedBackend === "local_gpu" && (
            <label>
              Compute Type
              <select
                value={selectedComputeType}
                onChange={(event) => setSelectedComputeType(event.target.value)}
                disabled={isRunning}
              >
                <option value="float16">float16 (quality)</option>
                <option value="int8_float16">int8_float16 (faster)</option>
              </select>
            </label>
          )}
        </div>

        <div className="actions">
          <button className="primary" onClick={startFileTranscription} disabled={isRunning}>
            Transcribe File (Phase 1)
          </button>
          <button onClick={startMicrophoneSession} disabled={isRunning}>
            Start Microphone
          </button>
          <button onClick={startSystemAudioSession} disabled={isRunning}>
            Start System Audio
          </button>
          <button onClick={stopRun} disabled={!isRunning}>
            Stop
          </button>
          <button onClick={newSession} disabled={isRunning}>
            New Session
          </button>
          <button onClick={restoreLatest} disabled={isRunning}>
            Restore Latest
          </button>
        </div>
      </header>

      <section className="status-grid">
        <div className="card">
          <span>Session State</span>
          <strong>{state.session.status}</strong>
        </div>
        <div className="card">
          <span>Source Type</span>
          <strong>{state.session.source}</strong>
        </div>
        <div className="card">
          <span>Backend Mode</span>
          <strong>{state.session.backend}</strong>
        </div>
        <div className="card">
          <span>Backend State</span>
          <strong>{state.backendRuntime}</strong>
        </div>
        <div className="card">
          <span>Language</span>
          <strong>{state.session.language}</strong>
        </div>
        <div className="card">
          <span>Compute Type</span>
          <strong>
            {state.session.computeType ?? (state.session.backend === "local_cpu" ? "int8" : "-")}
          </strong>
        </div>
        <div className="card">
          <span>Input File</span>
          <strong>{state.session.inputFileName ?? "-"}</strong>
        </div>
        <div className="card">
          <span>Input Size</span>
          <strong>{formatBytes(state.session.inputFileBytes)}</strong>
        </div>
        <div className="card">
          <span>Session Timer</span>
          <strong>{formatElapsed(elapsedMs)}</strong>
        </div>
      </section>

      <main className="layout">
        <section className="panel transcript">
          <h2>📝 Transcript Stream</h2>
          <div className="transcript-feed" ref={transcriptContainerRef}>
            {state.finalSegments.map((segment) => (
              <div key={segment.segmentId} className="line final">
                <p>{segment.text}</p>
              </div>
            ))}

            {state.interimText ? (
              <div className="line interim">
                <p>{state.interimText}</p>
              </div>
            ) : null}

            {state.finalSegments.length === 0 && !state.interimText ? (
              <p className="empty">No transcript yet. Run file transcription or start microphone capture.</p>
            ) : null}
          </div>
        </section>

        <section className="panel events">
          <h2>⚡ Event Log</h2>
          <ul ref={eventsContainerRef}>
            {state.events
              .slice()
              .map((event, index) => (
                <li key={`${event.type}-${index}`}>
                  <code>{event.type}</code>
                  <span>{describeEvent(event)}</span>
                </li>
              ))}
          </ul>
        </section>
      </main>

      <section className="panel persistence">
        <h2>💾 Session Artifact Writer</h2>
        <p>{actionMessage}</p>
        <p className="layout-plan">
          Planned structure: {plannedLayout.sessionJsonPath}, {plannedLayout.eventsJsonlPath}, {plannedLayout.transcriptMdPath}
        </p>
        {writeResult ? (
          <div className="write-result">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.65rem' }}>
              <div>
                <p>
                  <strong>Persisted:</strong> {writeResult.persisted ? "yes" : "no"}
                </p>
                <p>
                  <strong>Message:</strong> {writeResult.message}
                </p>
              </div>
              {writeResult.sessionDir && (
                <button onClick={() => openPath(writeResult.sessionDir!)}>
                  📂 Open Folder
                </button>
              )}
            </div>
            {writeResult.persisted ? (
              <>
                <p>
                  <strong>session.json:</strong>{" "}
                  <a href="#" onClick={(e) => { e.preventDefault(); openPath(writeResult.sessionJsonPath!); }}>
                    {writeResult.sessionJsonPath}
                  </a>
                </p>
                <p>
                  <strong>events.jsonl:</strong>{" "}
                  <a href="#" onClick={(e) => { e.preventDefault(); openPath(writeResult.eventsJsonlPath!); }}>
                    {writeResult.eventsJsonlPath}
                  </a>
                </p>
                <p>
                  <strong>transcript.md:</strong>{" "}
                  <a href="#" onClick={(e) => { e.preventDefault(); openPath(writeResult.transcriptMdPath!); }}>
                    {writeResult.transcriptMdPath}
                  </a>
                </p>
              </>
            ) : null}
          </div>
        ) : null}
        <pre>{JSON.stringify(snapshot, null, 2)}</pre>
      </section>
    </div>
  );
}
