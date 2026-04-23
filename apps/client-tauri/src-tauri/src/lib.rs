use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteSessionArtifactsRequest {
    session: Value,
    events: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteSessionArtifactsResponse {
    session_dir: String,
    session_json_path: String,
    events_jsonl_path: String,
    transcript_md_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunPythonFileTranscriptionRequest {
    session: Value,
    backend: String,
    source: String,
    input_file_name: String,
    input_file_bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunPythonFileTranscriptionResponse {
    events: Vec<Value>,
    worker_input_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunPythonMicrophoneChunkTranscriptionRequest {
    session: Value,
    backend: String,
    source: String,
    language: String,
    chunk_index: u32,
    sample_rate: u32,
    channels: u32,
    chunk_duration_ms: u32,
    sample_count: u32,
    mime_type: Option<String>,
    input_chunk_bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunPythonMicrophoneChunkTranscriptionResponse {
    events: Vec<Value>,
    worker_input_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartPythonMicrophoneWorkerRequest {
    session: Value,
    backend: String,
    source: String,
    language: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartPythonMicrophoneWorkerResponse {
    backend: String,
    model: String,
    device: String,
    compute_type: String,
    worker_startup_ms: u64,
    model_load_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessPythonMicrophoneChunkTranscriptionRequest {
    session: Value,
    backend: String,
    source: String,
    language: String,
    chunk_index: u32,
    sample_rate: u32,
    channels: u32,
    chunk_duration_ms: u32,
    sample_count: u32,
    mime_type: Option<String>,
    input_chunk_bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessPythonMicrophoneChunkTranscriptionResponse {
    events: Vec<Value>,
    worker_input_path: String,
    processing_latency_ms: u64,
    first_chunk_latency_ms: Option<u64>,
    backend: String,
    device: String,
    compute_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopPythonMicrophoneWorkerRequest {
    session: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StopPythonMicrophoneWorkerResponse {
    stopped: bool,
    detail: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PollSysAudioEventsRequest {
    session: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PollSysAudioEventsResponse {
    events: Vec<Value>,
}

#[tauri::command]
fn poll_sys_audio_events(
    request: PollSysAudioEventsRequest,
) -> Result<PollSysAudioEventsResponse, String> {
    let session_id = session_id_from_value(&request.session)?;

    let mut workers_guard = persistent_workers()
        .lock()
        .map_err(|error| format!("failed to lock worker registry: {error}"))?;

    let worker = workers_guard
        .get_mut(&session_id)
        .ok_or_else(|| format!("persistent worker not found for session {}", session_id))?;

    // Wait and read one json line from stdout
    let payload = read_worker_json_line(
        &mut worker.stdout,
        "poll_sys_audio_events waiting for chunk result",
    )?;

    let kind = payload
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    if kind == "chunk_result" {
        let events = payload
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(PollSysAudioEventsResponse { events })
    } else if kind == "stopped" {
        Ok(PollSysAudioEventsResponse { events: vec![] })
    } else if kind == "fatal" || kind == "chunk_error" {
        let msg = payload.get("message").and_then(Value::as_str).unwrap_or("unknown error");
        Err(format!("worker error: {}", msg))
    } else {
        Ok(PollSysAudioEventsResponse { events: vec![] })
    }
}

#[derive(Debug, Deserialize)]
struct PythonRuntimeSnapshot {
    executable: String,
    prefix: String,
    base_prefix: String,
    sys_path: Vec<String>,
}

#[derive(Debug, Default)]
struct GpuDllDiscovery {
    searched_roots: Vec<PathBuf>,
    cublas_hits: Vec<PathBuf>,
    cudart_hits: Vec<PathBuf>,
    cudnn_hits: Vec<PathBuf>,
    dll_parent_dirs: Vec<PathBuf>,
}

#[derive(Debug)]
struct PersistentMicWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    backend: String,
    source: String,
    language: String,
    model: String,
    device: String,
    compute_type: String,
    started_at: Instant,
    first_chunk_seen: bool,
}

static PERSISTENT_MIC_WORKERS: OnceLock<Mutex<HashMap<String, PersistentMicWorker>>> =
    OnceLock::new();

#[tauri::command]
fn ludo_ping() -> &'static str {
    "ludo-phase1-ok"
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();

    if cleaned.is_empty() {
        "input.bin".to_string()
    } else {
        cleaned
    }
}

fn now_ms_u64() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn persistent_workers() -> &'static Mutex<HashMap<String, PersistentMicWorker>> {
    PERSISTENT_MIC_WORKERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_id_from_value(session: &Value) -> Result<String, String> {
    session
        .get("sessionId")
        .and_then(Value::as_str)
        .map(std::string::ToString::to_string)
        .ok_or_else(|| "session.sessionId is required".to_string())
}

fn root_dir_from_manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
}

fn worker_service_dir() -> PathBuf {
    root_dir_from_manifest().join("services").join("asr-worker-python")
}

fn python_path_separator() -> &'static str {
    if cfg!(windows) {
        ";"
    } else {
        ":"
    }
}

fn parse_worker_events(stdout: &str) -> Vec<Value> {
    stdout
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }

            match serde_json::from_str::<Value>(trimmed) {
                Ok(json) if json.get("type").is_some() => Some(json),
                _ => None,
            }
        })
        .collect()
}

fn ensure_supported_backend(backend: &str) -> Result<(), String> {
    if matches!(backend, "local_gpu" | "local_cpu" | "azure_server") {
        Ok(())
    } else {
        Err(format!(
            "unsupported backend '{}'. expected local_gpu, local_cpu, or azure_server",
            backend
        ))
    }
}

fn ensure_supported_language(language: &str) -> Result<(), String> {
    if matches!(language, "ko" | "en" | "auto") {
        Ok(())
    } else {
        Err(format!(
            "unsupported language '{}'. expected ko, en, or auto",
            language
        ))
    }
}

fn resolve_python_runtime_snapshot(
    python_executable: &str,
    service_dir: &Path,
    python_path: &str,
) -> Result<PythonRuntimeSnapshot, String> {
    let introspect_script = r#"
import json
import sys
print(json.dumps({
    "executable": sys.executable,
    "prefix": sys.prefix,
    "base_prefix": sys.base_prefix,
    "sys_path": [p for p in sys.path if isinstance(p, str)],
}))
"#;

    let output = Command::new(python_executable)
        .current_dir(service_dir)
        .env("PYTHONPATH", python_path)
        .arg("-c")
        .arg(introspect_script)
        .output()
        .map_err(|error| format!("failed to introspect python runtime '{python_executable}': {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "python runtime introspection failed for '{}': {}",
            python_executable,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    serde_json::from_str::<PythonRuntimeSnapshot>(&stdout).map_err(|error| {
        format!(
            "failed to parse python runtime introspection output. stdout='{}' error={}",
            stdout, error
        )
    })
}

fn push_unique_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<String>, path: PathBuf) {
    let key = path.to_string_lossy().to_lowercase();
    if seen.insert(key) {
        paths.push(path);
    }
}

fn discover_local_gpu_dlls(snapshot: &PythonRuntimeSnapshot) -> GpuDllDiscovery {
    let mut discovery = GpuDllDiscovery::default();
    let mut seen_roots: HashSet<String> = HashSet::new();
    let mut candidate_roots: Vec<PathBuf> = Vec::new();

    let executable_path = PathBuf::from(&snapshot.executable);
    if let Some(exe_dir) = executable_path.parent() {
        push_unique_path(
            &mut candidate_roots,
            &mut seen_roots,
            exe_dir.to_path_buf(),
        );
        if let Some(parent) = exe_dir.parent() {
            push_unique_path(&mut candidate_roots, &mut seen_roots, parent.to_path_buf());
        }
    }

    for candidate in [&snapshot.prefix, &snapshot.base_prefix] {
        if !candidate.trim().is_empty() {
            push_unique_path(
                &mut candidate_roots,
                &mut seen_roots,
                PathBuf::from(candidate),
            );
        }
    }

    for path in &snapshot.sys_path {
        if path.trim().is_empty() {
            continue;
        }
        push_unique_path(
            &mut candidate_roots,
            &mut seen_roots,
            PathBuf::from(path),
        );
    }

    let mut dll_parent_seen: HashSet<String> = HashSet::new();
    let mut visited_dirs: HashSet<String> = HashSet::new();
    let mut stack: Vec<PathBuf> = Vec::new();

    for root in candidate_roots {
        if root.is_dir() {
            discovery.searched_roots.push(root.clone());
            stack.push(root);
        }
    }

    while let Some(dir) = stack.pop() {
        let dir_key = dir.to_string_lossy().to_lowercase();
        if !visited_dirs.insert(dir_key) {
            continue;
        }

        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }

            let file_name = match path.file_name().and_then(|name| name.to_str()) {
                Some(name) => name.to_lowercase(),
                None => continue,
            };

            let mut matched = false;
            if file_name == "cublas64_12.dll" {
                discovery.cublas_hits.push(path.clone());
                matched = true;
            } else if file_name == "cudart64_12.dll" {
                discovery.cudart_hits.push(path.clone());
                matched = true;
            } else if file_name.starts_with("cudnn") && file_name.ends_with(".dll") {
                discovery.cudnn_hits.push(path.clone());
                matched = true;
            }

            if matched {
                if let Some(parent) = path.parent() {
                    let parent_key = parent.to_string_lossy().to_lowercase();
                    if dll_parent_seen.insert(parent_key) {
                        discovery.dll_parent_dirs.push(parent.to_path_buf());
                    }
                }
            }
        }
    }

    discovery
}

fn configure_windows_gpu_runtime_env(
    command: &mut Command,
    backend: &str,
    python_executable: &str,
    service_dir: &Path,
    python_path: &str,
) -> Result<(), String> {
    if !cfg!(windows) || backend != "local_gpu" {
        return Ok(());
    }

    let snapshot = resolve_python_runtime_snapshot(python_executable, service_dir, python_path)?;
    let discovery = discover_local_gpu_dlls(&snapshot);

    eprintln!(
        "[LUDO][worker-launch] backend={} python={} prefix={} base_prefix={}",
        backend, snapshot.executable, snapshot.prefix, snapshot.base_prefix
    );
    eprintln!(
        "[LUDO][worker-launch] gpu-dll-search roots={}",
        discovery
            .searched_roots
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<String>>()
            .join(" | ")
    );
    eprintln!(
        "[LUDO][worker-launch] gpu-dll-hits cublas={} cudart={} cudnn={}",
        discovery
            .cublas_hits
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<String>>()
            .join(" | "),
        discovery
            .cudart_hits
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<String>>()
            .join(" | "),
        discovery
            .cudnn_hits
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<String>>()
            .join(" | ")
    );

    let missing_cublas = discovery.cublas_hits.is_empty();
    let missing_cudart = discovery.cudart_hits.is_empty();
    let missing_cudnn = discovery.cudnn_hits.is_empty();

    if missing_cublas || missing_cudart || missing_cudnn {
        return Err(format!(
            "local_gpu runtime DLL discovery failed for python '{}'. missing: {}{}{}. \
             expected to find cublas64_12.dll, cudart64_12.dll, and cudnn*.dll in active Python environment. \
             checked roots: {}. \
             install/reinstall GPU runtime wheels (ctranslate2/faster-whisper CUDA deps) in the same Python used by the app.",
            snapshot.executable,
            if missing_cublas { "cublas64_12.dll " } else { "" },
            if missing_cudart { "cudart64_12.dll " } else { "" },
            if missing_cudnn { "cudnn*.dll" } else { "" },
            discovery
                .searched_roots
                .iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<String>>()
                .join(" | ")
        ));
    }

    let discovered_dirs = discovery
        .dll_parent_dirs
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<String>>();

    let existing_path = std::env::var("PATH").unwrap_or_default();
    let patched_path = if existing_path.is_empty() {
        discovered_dirs.join(";")
    } else {
        format!("{};{}", discovered_dirs.join(";"), existing_path)
    };

    command.env("PATH", patched_path);
    eprintln!(
        "[LUDO][worker-launch] path-patch backend={} prepended_dirs={} summary={}",
        backend,
        discovered_dirs.len(),
        discovered_dirs.join(" | ")
    );

    Ok(())
}

fn resolve_worker_python_runtime() -> (PathBuf, String, String) {
    let service_dir = worker_service_dir();
    let python_executable =
        std::env::var("LUDO_PYTHON_PATH").unwrap_or_else(|_| "python".to_string());
    let service_src = service_dir.join("src");

    let mut python_path = service_src.to_string_lossy().to_string();
    if let Ok(existing) = std::env::var("PYTHONPATH") {
        if !existing.is_empty() {
            python_path = format!("{python_path}{}{existing}", python_path_separator());
        }
    }

    (service_dir, python_executable, python_path)
}

fn run_worker_process(
    mode: &str,
    session_id: &str,
    backend: &str,
    source: &str,
    input_file_path: &Path,
    input_file_name: &str,
    chunk_index: Option<u32>,
    mime_type: Option<&str>,
    language: Option<&str>,
    sample_rate: Option<u32>,
    channels: Option<u32>,
    chunk_duration_ms: Option<u32>,
    sample_count: Option<u32>,
    vad_filter: Option<bool>,
    compute_type: Option<&str>,
) -> Result<Vec<Value>, String> {
    let (service_dir, python_executable, python_path) = resolve_worker_python_runtime();

    let mut command = Command::new(&python_executable);
    command
        .current_dir(&service_dir)
        .env("PYTHONPATH", &python_path)
        .arg("-m")
        .arg("asr_worker_python.worker")
        .arg("--mode")
        .arg(mode)
        .arg("--session-id")
        .arg(session_id)
        .arg("--backend")
        .arg(backend)
        .arg("--source")
        .arg(source)
        .arg("--input-file")
        .arg(input_file_path)
        .arg("--file-name")
        .arg(input_file_name);

    if let Some(index) = chunk_index {
        command.arg("--chunk-index").arg(index.to_string());
    }

    if let Some(mime) = mime_type {
        command.arg("--mime-type").arg(mime);
    }

    if let Some(lang) = language {
        command.arg("--language").arg(lang);
    }

    if let Some(rate) = sample_rate {
        command.arg("--sample-rate").arg(rate.to_string());
    }

    if let Some(ch) = channels {
        command.arg("--channels").arg(ch.to_string());
    }

    if let Some(duration_ms) = chunk_duration_ms {
        command
            .arg("--chunk-duration-ms")
            .arg(duration_ms.to_string());
    }

    if let Some(samples) = sample_count {
        command.arg("--sample-count").arg(samples.to_string());
    }

    if let Some(vad) = vad_filter {
        command
            .arg("--vad-filter")
            .arg(if vad { "true" } else { "false" });
    }

    if backend == "local_gpu" {
        let env_ct = std::env::var("LUDO_GPU_COMPUTE_TYPE").ok();
        let effective_ct = compute_type
            .filter(|ct| !ct.is_empty())
            .map(|ct| ct.to_string())
            .or(env_ct)
            .unwrap_or_else(|| "float16".to_string());
        command.env("LUDO_GPU_COMPUTE_TYPE", &effective_ct);
        eprintln!(
            "[LUDO][worker-launch] backend={backend} mode={mode} compute_type={effective_ct} session={session_id}"
        );
    }

    configure_windows_gpu_runtime_env(
        &mut command,
        backend,
        &python_executable,
        &service_dir,
        &python_path,
    )?;

    let output = command
        .output()
        .map_err(|error| format!("failed to invoke python worker '{python_executable}': {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let parsed_events = parse_worker_events(&stdout);

    if !output.status.success() {
        if !parsed_events.is_empty() {
            let status_code = output
                .status
                .code()
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string());
            eprintln!(
                "[LUDO][worker-launch] recovered {} events from non-zero worker exit status={} backend={} mode={} session={}",
                parsed_events.len(),
                status_code,
                backend,
                mode,
                session_id
            );

            let mut recovered = parsed_events;
            recovered.push(json!({
                "type": "backend_state",
                "sessionId": session_id,
                "at": SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or(0),
                "state": "error",
                "detail": format!(
                    "worker exited with status {} after emitting transcript events",
                    status_code
                ),
            }));
            return Ok(recovered);
        }

        return Err(format!(
            "python worker exited with status {}. stderr: {}",
            output
                .status
                .code()
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            stderr.trim()
        ));
    }

    if parsed_events.is_empty() {
        return Err(format!(
            "python worker returned no transcript events. stdout: '{}' stderr: '{}'",
            stdout.trim(),
            stderr.trim()
        ));
    }

    Ok(parsed_events)
}

fn value_as_u64(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_i64().map(|item| item.max(0) as u64))
}

fn read_worker_json_line(
    stdout: &mut BufReader<ChildStdout>,
    context: &str,
) -> Result<Value, String> {
    let mut line = String::new();
    let read = stdout
        .read_line(&mut line)
        .map_err(|error| format!("{context}: failed to read worker stdout: {error}"))?;
    if read == 0 {
        return Err(format!("{context}: worker stdout closed unexpectedly"));
    }

    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(format!("{context}: worker returned empty stdout line"));
    }

    serde_json::from_str::<Value>(trimmed)
        .map_err(|error| format!("{context}: failed to parse worker json line '{trimmed}': {error}"))
}

fn shutdown_persistent_worker(mut worker: PersistentMicWorker, reason: &str) -> String {
    let stop_payload = json!({
        "type": "stop",
        "requestId": format!("stop-{}", now_ms_u64()),
        "reason": reason,
    });

    if writeln!(worker.stdin, "{stop_payload}").is_ok() {
        let _ = worker.stdin.flush();
    }

    let deadline = Instant::now() + Duration::from_millis(1600);
    loop {
        match worker.child.try_wait() {
            Ok(Some(status)) => {
                return format!("worker exited with status={status}");
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = worker.child.kill();
                    match worker.child.wait() {
                        Ok(status) => {
                            return format!("worker forced to stop with status={status}");
                        }
                        Err(error) => {
                            return format!("worker kill attempted but wait failed: {error}");
                        }
                    }
                }

                thread::sleep(Duration::from_millis(40));
            }
            Err(error) => {
                let _ = worker.child.kill();
                return format!("worker stop failed while polling process state: {error}");
            }
        }
    }
}

fn write_microphone_chunk_file(
    app: &tauri::AppHandle,
    session_id: &str,
    chunk_index: u32,
    input_chunk_bytes: &[u8],
) -> Result<PathBuf, String> {
    let app_local_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("unable to resolve app local data directory: {error}"))?;

    let chunk_dir = app_local_dir
        .join("sessions")
        .join(session_id)
        .join("raw")
        .join("mic_chunks");
    fs::create_dir_all(&chunk_dir)
        .map_err(|error| format!("failed to create microphone chunk directory: {error}"))?;

    let worker_input_path = chunk_dir.join(format!("chunk_{:05}.wav", chunk_index));

    fs::write(&worker_input_path, input_chunk_bytes)
        .map_err(|error| format!("failed to write microphone chunk file: {error}"))?;

    if chunk_index <= 3 {
        let debug_dir = app_local_dir
            .join("sessions")
            .join(session_id)
            .join("raw")
            .join("mic_debug");
        fs::create_dir_all(&debug_dir)
            .map_err(|error| format!("failed to create microphone debug directory: {error}"))?;

        let debug_path = debug_dir.join(format!("debug_chunk_{:05}.wav", chunk_index));
        fs::write(&debug_path, input_chunk_bytes)
            .map_err(|error| format!("failed to write microphone debug chunk file: {error}"))?;
    }

    Ok(worker_input_path)
}

#[tauri::command]
fn start_python_microphone_worker(
    request: StartPythonMicrophoneWorkerRequest,
) -> Result<StartPythonMicrophoneWorkerResponse, String> {
    ensure_supported_backend(&request.backend)?;
    ensure_supported_language(&request.language)?;

    if request.backend == "azure_server" {
        return Err(
            "azure_server persistent local worker is not supported. Use the server ASR adapter path."
                .to_string(),
        );
    }

    let session_id = session_id_from_value(&request.session)?;
    let session_id_for_log = session_id.clone();

    if let Some(existing) = persistent_workers()
        .lock()
        .map_err(|error| format!("failed to lock worker registry: {error}"))?
        .remove(&session_id)
    {
        let detail = shutdown_persistent_worker(existing, "restarting for new session state");
        eprintln!(
            "[LUDO][persistent-worker] previous worker removed before start session={} detail={}",
            session_id_for_log, detail
        );
    }

    let (service_dir, python_executable, python_path) = resolve_worker_python_runtime();

    let mut command = Command::new(&python_executable);
    command
        .current_dir(&service_dir)
        .env("PYTHONPATH", &python_path)
        .arg("-m")
        .arg("asr_worker_python.worker")
        .arg("--mode")
        .arg(if request.source == "system" { "sys_audio_stream" } else { "mic_stream" })
        .arg("--session-id")
        .arg(&session_id)
        .arg("--backend")
        .arg(&request.backend)
        .arg("--source")
        .arg(&request.source)
        .arg("--language")
        .arg(&request.language)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if request.backend == "local_gpu" {
        let env_ct = std::env::var("LUDO_GPU_COMPUTE_TYPE").ok();
        let session_ct = request.session
            .get("computeType")
            .and_then(Value::as_str)
            .filter(|ct| !ct.is_empty());
        let effective_ct = session_ct
            .map(|ct| ct.to_string())
            .or(env_ct)
            .unwrap_or_else(|| "float16".to_string());
        command.env("LUDO_GPU_COMPUTE_TYPE", &effective_ct);
        eprintln!(
            "[LUDO][persistent-worker] compute_type={effective_ct} session={session_id}"
        );
    }

    configure_windows_gpu_runtime_env(
        &mut command,
        &request.backend,
        &python_executable,
        &service_dir,
        &python_path,
    )?;

    let started_at = Instant::now();
    eprintln!(
        "[LUDO][persistent-worker] start session={} backend={} source={} language={} python={}",
        session_id, request.backend, request.source, request.language, python_executable
    );

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn persistent python worker '{python_executable}': {error}"))?;

    if let Some(stderr) = child.stderr.take() {
        let session_for_thread = session_id.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!(
                    "[LUDO][persistent-worker][stderr][session={}] {}",
                    session_for_thread, line
                );
            }
        });
    }

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "persistent worker stdin is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "persistent worker stdout is unavailable".to_string())?;
    let mut stdout_reader = BufReader::new(stdout);

    let ready_payload = read_worker_json_line(
        &mut stdout_reader,
        "persistent worker start: waiting for ready payload",
    )?;
    let ready_kind = ready_payload
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    if ready_kind == "fatal" {
        let message = ready_payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown persistent worker startup failure");
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("persistent worker startup failed: {message}"));
    }

    if ready_kind != "ready" {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "persistent worker startup expected ready payload but received kind='{}' payload={}",
            ready_kind, ready_payload
        ));
    }

    let model = ready_payload
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let device = ready_payload
        .get("device")
        .and_then(Value::as_str)
        .unwrap_or_else(|| if request.backend == "local_gpu" { "cuda" } else { "cpu" })
        .to_string();
    let compute_type = ready_payload
        .get("computeType")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let model_load_ms = ready_payload
        .get("modelLoadMs")
        .and_then(value_as_u64)
        .unwrap_or(0);
    let worker_startup_ms = ready_payload
        .get("startupMs")
        .and_then(value_as_u64)
        .unwrap_or_else(|| started_at.elapsed().as_millis() as u64);

    eprintln!(
        "[LUDO][persistent-worker] ready session={} backend={} model={} device={} compute={} startupMs={} modelLoadMs={}",
        session_id, request.backend, model, device, compute_type, worker_startup_ms, model_load_ms
    );

    let worker = PersistentMicWorker {
        child,
        stdin,
        stdout: stdout_reader,
        backend: request.backend.clone(),
        source: request.source.clone(),
        language: request.language.clone(),
        model,
        device: device.clone(),
        compute_type: compute_type.clone(),
        started_at,
        first_chunk_seen: false,
    };

    persistent_workers()
        .lock()
        .map_err(|error| format!("failed to lock worker registry for insert: {error}"))?
        .insert(session_id, worker);

    Ok(StartPythonMicrophoneWorkerResponse {
        backend: request.backend,
        model: ready_payload
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        device,
        compute_type,
        worker_startup_ms,
        model_load_ms,
    })
}

#[tauri::command]
fn process_python_microphone_chunk_transcription(
    app: tauri::AppHandle,
    request: ProcessPythonMicrophoneChunkTranscriptionRequest,
) -> Result<ProcessPythonMicrophoneChunkTranscriptionResponse, String> {
    if request.input_chunk_bytes.is_empty() {
        return Err("input_chunk_bytes is empty".to_string());
    }

    ensure_supported_backend(&request.backend)?;
    ensure_supported_language(&request.language)?;

    let session_id = session_id_from_value(&request.session)?;
    let worker_input_path = write_microphone_chunk_file(
        &app,
        &session_id,
        request.chunk_index,
        &request.input_chunk_bytes,
    )?;

    let request_id = format!("chunk-{}-{}", request.chunk_index, now_ms_u64());
    let payload = json!({
        "type": "transcribe_chunk",
        "requestId": request_id,
        "inputFile": worker_input_path.to_string_lossy().to_string(),
        "chunkIndex": request.chunk_index,
        "language": &request.language,
        "sampleRate": request.sample_rate,
        "channels": request.channels,
        "chunkDurationMs": request.chunk_duration_ms,
        "sampleCount": request.sample_count,
        "mimeType": &request.mime_type,
        "source": &request.source,
        "backend": &request.backend,
    });

    let command_started = Instant::now();
    let mut workers_guard = persistent_workers()
        .lock()
        .map_err(|error| format!("failed to lock worker registry: {error}"))?;

    let worker = workers_guard.get_mut(&session_id).ok_or_else(|| {
        format!(
            "persistent microphone worker is not running for session '{}'. start worker first",
            session_id
        )
    })?;

    if worker.backend != request.backend {
        return Err(format!(
            "persistent worker backend mismatch. worker={} request={}",
            worker.backend, request.backend
        ));
    }

    if worker.source != request.source {
        eprintln!(
            "[LUDO][persistent-worker] source mismatch session={} worker={} request={}",
            session_id, worker.source, request.source
        );
    }
    if worker.language != request.language {
        eprintln!(
            "[LUDO][persistent-worker] language override session={} worker={} request={}",
            session_id, worker.language, request.language
        );
    }

    writeln!(worker.stdin, "{payload}")
        .map_err(|error| format!("failed to write chunk payload to persistent worker stdin: {error}"))?;
    worker
        .stdin
        .flush()
        .map_err(|error| format!("failed to flush persistent worker stdin: {error}"))?;

    let response_payload = read_worker_json_line(
        &mut worker.stdout,
        "persistent worker chunk processing: waiting for chunk payload",
    )?;
    let kind = response_payload
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    if kind == "chunk_error" || kind == "fatal" {
        let message = response_payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown persistent worker chunk failure");
        return Err(format!("persistent worker chunk failure: {message}"));
    }

    if kind != "chunk_result" {
        return Err(format!(
            "persistent worker returned unexpected payload kind='{}' payload={}",
            kind, response_payload
        ));
    }

    let events = response_payload
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let metrics = response_payload
        .get("metrics")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let processing_latency_ms = metrics
        .get("processingMs")
        .and_then(value_as_u64)
        .unwrap_or_else(|| command_started.elapsed().as_millis() as u64);

    let first_chunk_latency_ms = if !worker.first_chunk_seen {
        worker.first_chunk_seen = true;
        Some(worker.started_at.elapsed().as_millis() as u64)
    } else {
        None
    };

    let response_device = response_payload
        .get("device")
        .and_then(Value::as_str)
        .unwrap_or(&worker.device)
        .to_string();
    let response_compute_type = response_payload
        .get("computeType")
        .and_then(Value::as_str)
        .unwrap_or(&worker.compute_type)
        .to_string();

    eprintln!(
        "[LUDO][persistent-worker] chunk-done session={} chunk={} backend={} model={} device={} compute={} processingMs={} firstChunkMs={}",
        session_id,
        request.chunk_index,
        request.backend,
        worker.model,
        response_device,
        response_compute_type,
        processing_latency_ms,
        first_chunk_latency_ms.unwrap_or(0)
    );

    Ok(ProcessPythonMicrophoneChunkTranscriptionResponse {
        events,
        worker_input_path: worker_input_path.to_string_lossy().to_string(),
        processing_latency_ms,
        first_chunk_latency_ms,
        backend: request.backend,
        device: response_device,
        compute_type: response_compute_type,
    })
}

#[tauri::command]
fn stop_python_microphone_worker(
    request: StopPythonMicrophoneWorkerRequest,
) -> Result<StopPythonMicrophoneWorkerResponse, String> {
    let session_id = session_id_from_value(&request.session)?;
    let removed = persistent_workers()
        .lock()
        .map_err(|error| format!("failed to lock worker registry for stop: {error}"))?
        .remove(&session_id);

    if let Some(worker) = removed {
        let detail = shutdown_persistent_worker(worker, "session stop requested");
        eprintln!(
            "[LUDO][persistent-worker] stopped session={} detail={}",
            session_id, detail
        );
        return Ok(StopPythonMicrophoneWorkerResponse {
            stopped: true,
            detail,
        });
    }

    Ok(StopPythonMicrophoneWorkerResponse {
        stopped: false,
        detail: "no persistent worker was running for this session".to_string(),
    })
}

#[tauri::command]
fn run_python_file_transcription(
    app: tauri::AppHandle,
    request: RunPythonFileTranscriptionRequest,
) -> Result<RunPythonFileTranscriptionResponse, String> {
    if request.input_file_bytes.is_empty() {
        return Err("input_file_bytes is empty".to_string());
    }

    if !matches!(
        request.backend.as_str(),
        "local_gpu" | "local_cpu" | "azure_server"
    ) {
        return Err(format!(
            "unsupported backend '{}'. expected local_gpu, local_cpu, or azure_server",
            request.backend
        ));
    }

    let language = request
        .session
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("auto");

    if !matches!(language, "ko" | "en" | "auto") {
        return Err(format!(
            "unsupported language '{}'. expected ko, en, or auto",
            language
        ));
    }

    let session_id = request
        .session
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "session.sessionId is required".to_string())?;

    let app_local_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("unable to resolve app local data directory: {error}"))?;

    let raw_dir = app_local_dir.join("sessions").join(session_id).join("raw");
    fs::create_dir_all(&raw_dir)
        .map_err(|error| format!("failed to create raw session directory: {error}"))?;

    let safe_name = sanitize_file_name(&request.input_file_name);
    let worker_input_path = raw_dir.join(format!("worker_input_{safe_name}"));

    fs::write(&worker_input_path, &request.input_file_bytes)
        .map_err(|error| format!("failed to write worker input file: {error}"))?;

    let compute_type = request.session
        .get("computeType")
        .and_then(Value::as_str);

    let events = run_worker_process(
        "file",
        session_id,
        &request.backend,
        &request.source,
        &worker_input_path,
        &request.input_file_name,
        None,
        None,
        Some(language),
        None,
        None,
        None,
        None,
        None,
        compute_type,
    )?;

    Ok(RunPythonFileTranscriptionResponse {
        events,
        worker_input_path: worker_input_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn run_python_microphone_chunk_transcription(
    app: tauri::AppHandle,
    request: RunPythonMicrophoneChunkTranscriptionRequest,
) -> Result<RunPythonMicrophoneChunkTranscriptionResponse, String> {
    if request.input_chunk_bytes.is_empty() {
        return Err("input_chunk_bytes is empty".to_string());
    }

    if !matches!(
        request.backend.as_str(),
        "local_gpu" | "local_cpu" | "azure_server"
    ) {
        return Err(format!(
            "unsupported backend '{}'. expected local_gpu, local_cpu, or azure_server",
            request.backend
        ));
    }

    if !matches!(request.language.as_str(), "ko" | "en" | "auto") {
        return Err(format!(
            "unsupported language '{}'. expected ko, en, or auto",
            request.language
        ));
    }

    let session_id = request
        .session
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "session.sessionId is required".to_string())?;

    let app_local_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("unable to resolve app local data directory: {error}"))?;

    let chunk_dir = app_local_dir
        .join("sessions")
        .join(session_id)
        .join("raw")
        .join("mic_chunks");
    fs::create_dir_all(&chunk_dir)
        .map_err(|error| format!("failed to create microphone chunk directory: {error}"))?;

    let worker_input_path = chunk_dir.join(format!("chunk_{:05}.wav", request.chunk_index));

    fs::write(&worker_input_path, &request.input_chunk_bytes)
        .map_err(|error| format!("failed to write microphone chunk file: {error}"))?;

    if request.chunk_index <= 3 {
        let debug_dir = app_local_dir
            .join("sessions")
            .join(session_id)
            .join("raw")
            .join("mic_debug");
        fs::create_dir_all(&debug_dir)
            .map_err(|error| format!("failed to create microphone debug directory: {error}"))?;

        let debug_path = debug_dir.join(format!("debug_chunk_{:05}.wav", request.chunk_index));
        fs::write(&debug_path, &request.input_chunk_bytes)
            .map_err(|error| format!("failed to write microphone debug chunk file: {error}"))?;
    }

    let compute_type = request.session
        .get("computeType")
        .and_then(Value::as_str);

    let events = run_worker_process(
        "mic_chunk",
        session_id,
        &request.backend,
        &request.source,
        &worker_input_path,
        &format!("mic_chunk_{:05}.wav", request.chunk_index),
        Some(request.chunk_index),
        request.mime_type.as_deref(),
        Some(&request.language),
        Some(request.sample_rate),
        Some(request.channels),
        Some(request.chunk_duration_ms),
        Some(request.sample_count),
        None,
        compute_type,
    )?;

    Ok(RunPythonMicrophoneChunkTranscriptionResponse {
        events,
        worker_input_path: worker_input_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn write_session_artifacts(
    app: tauri::AppHandle,
    request: WriteSessionArtifactsRequest,
) -> Result<WriteSessionArtifactsResponse, String> {
    let session_id = request
        .session
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "session.sessionId is required".to_string())?;

    let app_local_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("unable to resolve app local data directory: {error}"))?;

    let session_dir = app_local_dir.join("sessions").join(session_id);
    let transcript_dir = session_dir.join("transcript");

    fs::create_dir_all(&transcript_dir)
        .map_err(|error| format!("failed to create session directories: {error}"))?;

    let session_json_path = session_dir.join("session.json");
    let events_jsonl_path = session_dir.join("events.jsonl");
    let transcript_md_path = transcript_dir.join("transcript.md");

    let session_pretty = serde_json::to_string_pretty(&request.session)
        .map_err(|error| format!("failed to serialize session.json: {error}"))?;
    fs::write(&session_json_path, session_pretty)
        .map_err(|error| format!("failed to write session.json: {error}"))?;

    let mut events_file = File::create(&events_jsonl_path)
        .map_err(|error| format!("failed to create events.jsonl: {error}"))?;

    for event in &request.events {
        let line = serde_json::to_string(event)
            .map_err(|error| format!("failed to serialize event json: {error}"))?;
        writeln!(events_file, "{line}")
            .map_err(|error| format!("failed to write events.jsonl: {error}"))?;
    }

    let title = request
        .session
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("LUDO Session");
    let source = request
        .session
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let backend = request
        .session
        .get("backend")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let language = request
        .session
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let compute_type = request
        .session
        .get("computeType")
        .and_then(Value::as_str)
        .unwrap_or(if backend == "local_cpu" { "int8" } else { "unknown" });

    eprintln!(
        "[LUDO][session] write session={session_id} backend={backend} language={language} compute_type={compute_type}"
    );

    let generated_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("failed to read system time: {error}"))?
        .as_millis();

    let final_segments: Vec<String> = request
        .events
        .iter()
        .filter_map(|event| {
            let event_type = event.get("type")?.as_str()?;
            if event_type != "final" {
                return None;
            }

            event
                .get("text")
                .and_then(Value::as_str)
                .map(std::string::ToString::to_string)
        })
        .collect();

    let mut transcript_markdown = String::new();
    transcript_markdown.push_str("# LUDO Transcript\n\n");
    transcript_markdown.push_str(&format!("- sessionId: {session_id}\n"));
    transcript_markdown.push_str(&format!("- title: {title}\n"));
    transcript_markdown.push_str(&format!("- source: {source}\n"));
    transcript_markdown.push_str(&format!("- backend: {backend}\n"));
    transcript_markdown.push_str(&format!("- language: {language}\n"));
    transcript_markdown.push_str(&format!("- computeType: {compute_type}\n"));
    transcript_markdown.push_str(&format!("- generatedAtMs: {generated_at_ms}\n\n"));
    transcript_markdown.push_str("## Final Segments\n\n");

    if final_segments.is_empty() {
        transcript_markdown.push_str("- (no final segments were generated)\n");
    } else {
        for segment in final_segments {
            transcript_markdown.push_str(&format!("- {segment}\n"));
        }
    }

    fs::write(&transcript_md_path, transcript_markdown)
        .map_err(|error| format!("failed to write transcript.md: {error}"))?;

    Ok(WriteSessionArtifactsResponse {
        session_dir: session_dir.to_string_lossy().to_string(),
        session_json_path: session_json_path.to_string_lossy().to_string(),
        events_jsonl_path: events_jsonl_path.to_string_lossy().to_string(),
        transcript_md_path: transcript_md_path.to_string_lossy().to_string(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveMicrophoneRecordingRequest {
    session_id: String,
    wav_bytes: Vec<u8>,
}

#[tauri::command]
fn save_microphone_recording(
    app: tauri::AppHandle,
    request: SaveMicrophoneRecordingRequest,
) -> Result<String, String> {
    let app_local_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("unable to resolve app local data directory: {error}"))?;

    let raw_dir = app_local_dir
        .join("sessions")
        .join(&request.session_id)
        .join("raw");
    fs::create_dir_all(&raw_dir)
        .map_err(|error| format!("failed to create session raw directory: {error}"))?;

    let full_session_path = raw_dir.join("full_session.wav");

    fs::write(&full_session_path, &request.wav_bytes)
        .map_err(|error| format!("failed to write full_session.wav: {error}"))?;

    Ok(full_session_path.to_string_lossy().to_string())
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open path: {}", e))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ludo_ping,
            run_python_file_transcription,
            start_python_microphone_worker,
            poll_sys_audio_events,
            process_python_microphone_chunk_transcription,
            stop_python_microphone_worker,
            run_python_microphone_chunk_transcription,
            write_session_artifacts,
            save_microphone_recording,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running ludo tauri app");
}
