// ---------------------------------------------------------------- //
// MCP (Mission Control Platform) Tool Contracts for LUDO       //
// ---------------------------------------------------------------- //

// --- Core Types ---

export type ToolName = "get_session_summary" | "search_transcript" | "read_artifact";

export type ArtifactName = "meeting_minutes.md" | "action_items.md" | "explain_like_im_new.md";


// ---------------------------------------------------------------- //
// Tool: get_session_summary
// ---------------------------------------------------------------- //

export interface GetSessionSummary_Input {
  sessionId: string;
}

export interface GetSessionSummary_Output {
  sessionId: string;
  source: string;
  backend: string;
  language: string;
  status: string;
  hasTranscript: boolean;
  hasArtifacts: boolean;
  artifactFiles: ArtifactName[];
  transcriptStats: {
    finalSegmentCount: number;
    approxTextLength: number;
  };
}


// ---------------------------------------------------------------- //
// Tool: search_transcript
// ---------------------------------------------------------------- //

export interface SearchTranscript_Input {
  sessionId: string;
  query: string;
}

export interface SearchTranscript_Output {
  sessionId: string;
  query: string;
  matches: {
    segmentId: string;
    text: string;
    reference?: {
      startMs?: number;
      endMs?: number;
    };
  }[];
}


// ---------------------------------------------------------------- //
// Tool: read_artifact
// ---------------------------------------------------------------- //

export interface ReadArtifact_Input {
  sessionId: string;
  artifactName: ArtifactName;
}

export interface ReadArtifact_Output {
  sessionId: string;
  artifactName: ArtifactName;
  path: string;
  content: string;
}
