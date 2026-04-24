import { invoke } from "@tauri-apps/api/core";
import type { FinalSegment } from "../session/sessionStore";
import type { SessionRecord } from "@ludo/transcript-schema";

export type ArtifactProvider = "anthropic" | "openai" | "gemini";

export const ARTIFACT_PROVIDERS: ArtifactProvider[] = ["anthropic", "openai", "gemini"];

export interface ArtifactGenerateResult {
  success: boolean;
  message: string;
  providerUsed?: string;
  artifactsDir?: string;
  meetingMinutesPath?: string;
  actionItemsPath?: string;
  explainLikeImNewPath?: string;
}

interface NativeGenerateResponse {
  artifactsDir: string;
  meetingMinutesPath: string;
  actionItemsPath: string;
  explainLikeImNewPath: string;
  providerUsed: string;
}

export function buildTranscriptText(finalSegments: FinalSegment[]): string {
  return finalSegments.map((s) => s.text).join("\n");
}

export async function generateSessionArtifacts(
  session: SessionRecord,
  finalSegments: FinalSegment[],
  provider: ArtifactProvider,
): Promise<ArtifactGenerateResult> {
  const transcriptText = buildTranscriptText(finalSegments);

  if (!transcriptText.trim()) {
    return {
      success: false,
      message: "전사본이 비어 있습니다. 먼저 세션을 실행해 transcript를 생성하세요.",
    };
  }

  try {
    const response = await invoke<NativeGenerateResponse>("generate_session_artifacts", {
      request: {
        sessionId: session.sessionId,
        transcriptText,
        provider,
        sessionSource: session.source,
        sessionBackend: session.backend,
        sessionLanguage: session.language,
      },
    });

    return {
      success: true,
      message: `아티팩트가 성공적으로 생성되었습니다. (provider: ${response.providerUsed})`,
      providerUsed: response.providerUsed,
      artifactsDir: response.artifactsDir,
      meetingMinutesPath: response.meetingMinutesPath,
      actionItemsPath: response.actionItemsPath,
      explainLikeImNewPath: response.explainLikeImNewPath,
    };
  } catch (error) {
    return {
      success: false,
      message: `아티팩트 생성 실패: ${String(error)}`,
    };
  }
}
