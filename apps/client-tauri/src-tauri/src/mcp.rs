use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// --- Tool Contracts ---

// Tool: get_session_summary
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSessionSummaryInput {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSessionSummaryOutput {
    pub session_id: String,
    pub source: String,
    pub backend: String,
    pub language: String,
    pub status: String,
    pub has_transcript: bool,
    pub has_artifacts: bool,
    pub artifact_files: Vec<String>,
    pub transcript_stats: TranscriptStats,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptStats {
    pub final_segment_count: usize,
    pub approx_text_length: usize,
}

// Tool: search_transcript
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTranscriptInput {
    pub session_id: String,
    pub query: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTranscriptOutput {
    pub session_id: String,
    pub query: String,
    pub matches: Vec<TranscriptMatch>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMatch {
    pub segment_id: String,
    pub text: String,
    pub reference: Option<MatchReference>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchReference {
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
}

// Tool: read_artifact
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadArtifactInput {
    pub session_id: String,
    pub artifact_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadArtifactOutput {
    pub session_id: String,
    pub artifact_name: String,
    pub path: String,
    pub content: String,
}

// --- Tool Implementations ---

fn get_session_dir(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let app_local_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("failed to resolve app local data dir: {e}"))?;
    Ok(app_local_dir.join("sessions").join(session_id))
}

pub fn get_session_summary(
    app: &AppHandle,
    input: GetSessionSummaryInput,
) -> Result<GetSessionSummaryOutput, String> {
    let session_dir = get_session_dir(app, &input.session_id)?;
    let session_json_path = session_dir.join("session.json");

    if !session_json_path.exists() {
        return Err(format!("session.json not found for session '{}'", input.session_id));
    }

    let session_json_str = fs::read_to_string(session_json_path).map_err(|e| e.to_string())?;
    let session_data: Value = serde_json::from_str(&session_json_str).map_err(|e| e.to_string())?;

    let artifacts_dir = session_dir.join("artifacts");
    let allowed_artifacts = vec!["meeting_minutes.md", "action_items.md", "explain_like_im_new.md"];
    let artifact_files: Vec<String> = allowed_artifacts
        .iter()
        .filter(|name| artifacts_dir.join(name).exists())
        .map(|s| s.to_string())
        .collect();
    
    let mut transcript_stats = TranscriptStats {
        final_segment_count: 0,
        approx_text_length: 0,
    };

    let events_jsonl_path = session_dir.join("events.jsonl");
    if events_jsonl_path.exists() {
        if let Ok(file) = fs::File::open(events_jsonl_path) {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(file);
            for line in reader.lines().flatten() {
                if let Ok(event) = serde_json::from_str::<Value>(&line) {
                    if event["type"] == "final" {
                        transcript_stats.final_segment_count += 1;
                        if let Some(text) = event["text"].as_str() {
                            transcript_stats.approx_text_length += text.len();
                        }
                    }
                }
            }
        }
    }

    Ok(GetSessionSummaryOutput {
        session_id: input.session_id,
        source: session_data["source"].as_str().unwrap_or("").to_string(),
        backend: session_data["backend"].as_str().unwrap_or("").to_string(),
        language: session_data["language"].as_str().unwrap_or("").to_string(),
        status: session_data["status"].as_str().unwrap_or("").to_string(),
        has_transcript: session_dir.join("transcript").join("transcript.md").exists(),
        has_artifacts: !artifact_files.is_empty(),
        artifact_files,
        transcript_stats,
    })
}

pub fn search_transcript(
    app: &AppHandle,
    input: SearchTranscriptInput,
) -> Result<SearchTranscriptOutput, String> {
    let session_dir = get_session_dir(app, &input.session_id)?;
    let events_jsonl_path = session_dir.join("events.jsonl");
    let mut matches = Vec::new();
    let query_lower = input.query.to_lowercase();

    if events_jsonl_path.exists() {
        if let Ok(file) = fs::File::open(events_jsonl_path) {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(file);
            for line in reader.lines().flatten() {
                if let Ok(event) = serde_json::from_str::<Value>(&line) {
                    if event["type"] == "final" {
                        if let Some(text) = event["text"].as_str() {
                            if text.to_lowercase().contains(&query_lower) {
                                matches.push(TranscriptMatch {
                                    segment_id: event["segmentId"].as_str().unwrap_or("").to_string(),
                                    text: text.to_string(),
                                    reference: Some(MatchReference {
                                        start_ms: event["startMs"].as_u64(),
                                        end_ms: event["endMs"].as_u64(),
                                    }),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(SearchTranscriptOutput {
        session_id: input.session_id,
        query: input.query,
        matches,
    })
}

pub fn read_artifact(
    app: &AppHandle,
    input: ReadArtifactInput,
) -> Result<ReadArtifactOutput, String> {
    let allowed_artifacts = ["meeting_minutes.md", "action_items.md", "explain_like_im_new.md"];
    if !allowed_artifacts.contains(&input.artifact_name.as_str()) {
        return Err(format!("Artifact '{}' is not a valid or allowed artifact name.", input.artifact_name));
    }

    let session_dir = get_session_dir(app, &input.session_id)?;
    let artifact_path = session_dir.join("artifacts").join(&input.artifact_name);

    if !artifact_path.exists() {
        return Err(format!("Artifact '{}' not found for session '{}'", input.artifact_name, input.session_id));
    }

    let content = fs::read_to_string(&artifact_path).map_err(|e| e.to_string())?;

    Ok(ReadArtifactOutput {
        session_id: input.session_id,
        artifact_name: input.artifact_name,
        path: artifact_path.to_string_lossy().to_string(),
        content,
    })
}

// --- Dispatcher ---

pub fn dispatch(
    app: &AppHandle,
    tool_name: &str,
    input: Value,
) -> Result<Value, String> {
    match tool_name {
        "get_session_summary" => {
            let typed_input: GetSessionSummaryInput = serde_json::from_value(input).map_err(|e| e.to_string())?;
            let output = get_session_summary(app, typed_input)?;
            serde_json::to_value(output).map_err(|e| e.to_string())
        }
        "search_transcript" => {
            let typed_input: SearchTranscriptInput = serde_json::from_value(input).map_err(|e| e.to_string())?;
            let output = search_transcript(app, typed_input)?;
            serde_json::to_value(output).map_err(|e| e.to_string())
        }
        "read_artifact" => {
            let typed_input: ReadArtifactInput = serde_json::from_value(input).map_err(|e| e.to_string())?;
            let output = read_artifact(app, typed_input)?;
            serde_json::to_value(output).map_err(|e| e.to_string())
        }
        _ => Err(format!("Unknown MCP tool name: '{}'", tool_name)),
    }
}
