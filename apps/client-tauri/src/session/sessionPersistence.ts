import type { SessionSnapshot } from "@ludo/transcript-schema";

const SESSION_KEY_PREFIX = "ludo.phase1.session.";
const SESSION_INDEX_KEY = "ludo.phase1.session.index";
const LATEST_SESSION_KEY = "ludo.phase1.session.latest";

export interface SessionLayoutPlan {
  rootDir: string;
  sessionJsonPath: string;
  eventsJsonlPath: string;
  transcriptMdPath: string;
  artifactsDir: string;
  rawDir: string;
}

function hasLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function parseJson<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function sessionStorageKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

export function planSessionLayout(sessionId: string): SessionLayoutPlan {
  const rootDir = `sessions/${sessionId}`;
  return {
    rootDir,
    sessionJsonPath: `${rootDir}/session.json`,
    eventsJsonlPath: `${rootDir}/events.jsonl`,
    transcriptMdPath: `${rootDir}/transcript/transcript.md`,
    artifactsDir: `${rootDir}/artifacts`,
    rawDir: `${rootDir}/raw`,
  };
}

export function persistSessionSnapshot(snapshot: SessionSnapshot): void {
  if (!hasLocalStorage()) {
    return;
  }

  localStorage.setItem(
    sessionStorageKey(snapshot.session.sessionId),
    JSON.stringify(snapshot),
  );
  localStorage.setItem(LATEST_SESSION_KEY, snapshot.session.sessionId);

  const index = listStoredSessionIds();
  if (!index.includes(snapshot.session.sessionId)) {
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([...index, snapshot.session.sessionId]),
    );
  }
}

export function listStoredSessionIds(): string[] {
  if (!hasLocalStorage()) {
    return [];
  }

  const parsed = parseJson<string[]>(localStorage.getItem(SESSION_INDEX_KEY));
  return Array.isArray(parsed) ? parsed : [];
}

export function loadSessionSnapshot(sessionId: string): SessionSnapshot | null {
  if (!hasLocalStorage()) {
    return null;
  }

  return parseJson<SessionSnapshot>(localStorage.getItem(sessionStorageKey(sessionId)));
}

export function loadLatestSessionSnapshot(): SessionSnapshot | null {
  if (!hasLocalStorage()) {
    return null;
  }

  const sessionId = localStorage.getItem(LATEST_SESSION_KEY);
  if (!sessionId) {
    return null;
  }

  return loadSessionSnapshot(sessionId);
}
