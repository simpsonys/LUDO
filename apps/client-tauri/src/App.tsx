import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BackendMode, SessionLanguage, StreamHandle, TranscriptEvent } from "@ludo/transcript-schema";
import { BACKEND_MODES, createBackendAdapter } from "./asr/backendAdapter";
import {
  loadLatestSessionSnapshot,
  planSessionLayout,
  persistSessionSnapshot,
} from "./session/sessionPersistence";
import { writeSessionArtifacts, resolveSessionPaths, type SessionWriteResult } from "./session/sessionFileWriter";
import {
  applyTranscriptEvent,
  createInitialSessionState,
  createSessionRecord,
  hydrateSessionState,
  toSessionSnapshot,
  type SessionState,
} from "./session/sessionStore";
import {
  ARTIFACT_PROVIDERS,
  generateSessionArtifacts,
  type ArtifactGenerateResult,
  type ArtifactProvider,
} from "./artifacts/artifactGenerator";

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
  const [artifactResult, setArtifactResult] = useState<ArtifactGenerateResult | null>(null);
  const [isGeneratingArtifacts, setIsGeneratingArtifacts] = useState(false);
  const [selectedArtifactProvider, setSelectedArtifactProvider] = useState<ArtifactProvider>("gemini");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [isAsking, setIsAsking] = useState(false);

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

  // Restore writeResult after app restart if session already has data
  useEffect(() => {
    if (writeResult !== null) return;
    if (state.finalSegments.length === 0) return;
    void resolveSessionPaths(state.session.sessionId).then((result) => {
      if (result) setWriteResult(result);
    });
  }, [state.session.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setArtifactResult(null);
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

  const generateArtifacts = async () => {
    setIsGeneratingArtifacts(true);
    setArtifactResult(null);
    setActionMessage(`아티팩트 생성 중... (${selectedArtifactProvider} API 호출 중)`);

    const result = await generateSessionArtifacts(
      state.session,
      state.finalSegments,
      selectedArtifactProvider,
    );

    setArtifactResult(result);
    setActionMessage(result.message);
    setIsGeneratingArtifacts(false);
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
    setArtifactResult(null);
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
    setWriteResult(null);
    setActionMessage("Restored latest local snapshot.");

    if (latest.events.length > 0) {
      void resolveSessionPaths(latest.session.sessionId).then((result) => {
        if (result) setWriteResult(result);
      });
    }
  };

  const handleAskQuestion = async () => {
    if (!question.trim() || isAsking) return;
    setIsAsking(true);
    setAnswer("");
    try {
      const response: { answer: string; providerUsed: string } = await invoke("ask_session_question", {
        request: {
          sessionId: state.session.sessionId,
          question: question,
          provider: selectedArtifactProvider,
        },
      });
      setAnswer(response.answer);
    } catch (err) {
      setAnswer(`질문 처리 중 오류가 발생했습니다: ${String(err)}`);
    } finally {
      setIsAsking(false);
    }
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

          <div className="controls-label">
            <span>File Source</span>
            <div className="file-picker">
              <label
                htmlFor="file-source-input"
                className={`file-picker-btn${isRunning ? " file-picker-btn--disabled" : ""}`}
              >
                파일 선택
              </label>
              <span className={`file-picker-name${selectedFile ? " has-file" : ""}`}>
                {selectedFile ? selectedFile.name : "선택된 파일 없음"}
              </span>
              <input
                id="file-source-input"
                type="file"
                className="file-picker-input"
                onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                disabled={isRunning}
              />
            </div>
          </div>

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

          <label>
            Artifact Provider
            <select
              value={selectedArtifactProvider}
              onChange={(event) => setSelectedArtifactProvider(event.target.value as ArtifactProvider)}
              disabled={isRunning || isGeneratingArtifacts}
            >
              {ARTIFACT_PROVIDERS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
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
          <button
            onClick={() => void generateArtifacts()}
            disabled={isRunning || isGeneratingArtifacts || state.finalSegments.length === 0}
          >
            {isGeneratingArtifacts ? "생성 중..." : "아티팩트 생성"}
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

      <section className="panel persistence">
        <h2>🤖 Artifact Generation</h2>
        <p>
          세션 transcript를 기반으로 3개의 Markdown 아티팩트를 생성합니다.
          실행 전에 선택한 provider의 API 키가 환경 변수에 설정되어 있어야 합니다.
        </p>
        <p>
          <strong>Provider:</strong> {selectedArtifactProvider} &nbsp;|&nbsp;
          <strong>Transcript segments:</strong> {state.finalSegments.length}
        </p>

        {artifactResult ? (
          <div className="write-result">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.65rem" }}>
              <div>
                <p>
                  <strong>Result:</strong> {artifactResult.success ? "✅ 성공" : "❌ 실패"}
                </p>
                <p>{artifactResult.message}</p>
                {artifactResult.providerUsed && (
                  <p><strong>Provider used:</strong> {artifactResult.providerUsed}</p>
                )}
              </div>
              {artifactResult.artifactsDir && (
                <button onClick={() => openPath(artifactResult.artifactsDir!)}>
                  📂 Open artifacts/
                </button>
              )}
            </div>
            {artifactResult.success && (
              <>
                <p>
                  <strong>meeting_minutes.md:</strong>{" "}
                  <a href="#" onClick={(e) => { e.preventDefault(); openPath(artifactResult.meetingMinutesPath!); }}>
                    {artifactResult.meetingMinutesPath}
                  </a>
                </p>
                <p>
                  <strong>action_items.md:</strong>{" "}
                  <a href="#" onClick={(e) => { e.preventDefault(); openPath(artifactResult.actionItemsPath!); }}>
                    {artifactResult.actionItemsPath}
                  </a>
                </p>
                <p>
                  <strong>explain_like_im_new.md:</strong>{" "}
                  <a href="#" onClick={(e) => { e.preventDefault(); openPath(artifactResult.explainLikeImNewPath!); }}>
                    {artifactResult.explainLikeImNewPath}
                  </a>
                </p>
              </>
            )}
          </div>
        ) : (
          <p className="empty">아티팩트가 아직 생성되지 않았습니다. transcript가 있는 상태에서 "아티팩트 생성" 버튼을 클릭하세요.</p>
        )}
      </section>

      <section className="panel persistence">
        <h2>🔎 Session Q&A</h2>
        <p>세션 내용에 대해 질문하세요. (Transcript 및 생성된 Artifacts 기반)</p>
        
        <div className="qa-controls">
            <input 
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="예: '회의의 주요 결정 사항은 무엇이었나요?'"
                disabled={isAsking || state.finalSegments.length === 0}
                onKeyDown={(e) => { if (e.key === "Enter") void handleAskQuestion(); }}
            />
            <button
                onClick={() => void handleAskQuestion()}
                disabled={isAsking || state.finalSegments.length === 0 || !question.trim()}
            >
                {isAsking ? "질문 중..." : "질문하기"}
            </button>
        </div>

        {isAsking && <p>답변을 생성 중입니다...</p>}

        {answer && (
            <div className="qa-answer">
                <pre>{answer}</pre>
            </div>
        )}
      </section>
    </div>
  );
}
