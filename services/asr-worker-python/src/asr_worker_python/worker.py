from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import wave

try:
    import soundcard as sc
except ImportError:
    sc = None  # type: ignore[assignment]
from pathlib import Path
from typing import Iterable, Literal

import numpy as np

try:
    from faster_whisper import WhisperModel
except ImportError:  # pragma: no cover - runtime dependency check
    WhisperModel = None  # type: ignore[assignment]

SessionSource = Literal["mic", "system", "file"]
AsrBackend = Literal["local_gpu", "local_cpu", "azure_server"]
WorkerMode = Literal["file", "mic_chunk", "mic_stream", "sys_audio_stream"]
SessionLanguage = Literal["ko", "en", "auto"]
LOCAL_BACKENDS: set[AsrBackend] = {"local_gpu", "local_cpu"}

_MODEL_CACHE: dict[tuple[AsrBackend, str], WhisperModel] = {}
TARGET_SAMPLE_RATE = 16_000
_DLL_DIRECTORY_HANDLES: list[object] = []


def now_ms() -> int:
    return int(time.time() * 1000)


def emit_event(event: dict[str, object]) -> None:
    print(json.dumps(event, ensure_ascii=True), flush=True)


def log_debug(message: str) -> None:
    print(f"[LUDO worker] {message}", file=sys.stderr, flush=True)


def chunked(items: list[str], size: int) -> Iterable[list[str]]:
    for index in range(0, len(items), size):
        yield items[index : index + size]


def detect_cuda_runtime() -> tuple[bool, str]:
    if os.environ.get("LUDO_DISABLE_CUDA_CHECK", "0") == "1":
        return True, "cuda runtime check skipped by LUDO_DISABLE_CUDA_CHECK=1"

    try:
        result = subprocess.run(
            ["nvidia-smi", "-L"],
            check=False,
            capture_output=True,
            text=True,
            timeout=4,
        )
    except Exception:
        return False, "nvidia-smi is not available. CUDA runtime could not be validated."

    if result.returncode != 0:
        return False, "CUDA runtime probe failed. Switch to local_cpu or install GPU runtime dependencies."

    return True, "cuda runtime probe succeeded"


def configure_windows_gpu_dll_dirs() -> list[str]:
    if os.name != "nt":
        return []

    candidate_roots: list[Path] = []
    candidate_dirs: list[Path] = []
    seen_roots: set[str] = set()
    seen_dirs: set[str] = set()

    for raw in [sys.prefix, sys.base_prefix, str(Path(sys.executable).parent)] + list(sys.path):
        if not raw:
            continue
        root = Path(raw)
        if root.is_file():
            root = root.parent
        if not root.exists():
            continue
        key = str(root).lower()
        if key in seen_roots:
            continue
        seen_roots.add(key)
        candidate_roots.append(root)

    for root in candidate_roots:
        possible = [
            root / "Lib" / "site-packages" / "nvidia" / "cublas" / "bin",
            root / "Lib" / "site-packages" / "nvidia" / "cuda_runtime" / "bin",
            root / "Lib" / "site-packages" / "nvidia" / "cudnn" / "bin",
            root / "site-packages" / "nvidia" / "cublas" / "bin",
            root / "site-packages" / "nvidia" / "cuda_runtime" / "bin",
            root / "site-packages" / "nvidia" / "cudnn" / "bin",
            root / "nvidia" / "cublas" / "bin",
            root / "nvidia" / "cuda_runtime" / "bin",
            root / "nvidia" / "cudnn" / "bin",
        ]

        for path in possible:
            if not path.is_dir():
                continue
            key = str(path).lower()
            if key in seen_dirs:
                continue
            seen_dirs.add(key)
            candidate_dirs.append(path)

    patched_dirs: list[str] = []
    for dll_dir in candidate_dirs:
        try:
            handle = os.add_dll_directory(str(dll_dir))
            _DLL_DIRECTORY_HANDLES.append(handle)
            patched_dirs.append(str(dll_dir))
        except (AttributeError, OSError):
            continue

    if patched_dirs:
        existing_path = os.environ.get("PATH", "")
        merged = ";".join(patched_dirs + ([existing_path] if existing_path else []))
        os.environ["PATH"] = merged

    return patched_dirs


def extract_text_segments(input_file: Path, backend: AsrBackend, max_segments: int = 6) -> list[str]:
    data = input_file.read_bytes()
    sampled = data[: min(len(data), 256_000)]
    decoded = sampled.decode("utf-8", errors="ignore")
    tokens = re.findall(r"[A-Za-z0-9가-힣]+", decoded)
    words = [token for token in tokens if len(token) >= 2]

    segments: list[str] = []
    if words:
        for group in chunked(words, 10):
            segment = " ".join(group)
            if segment:
                segments.append(segment)
            if len(segments) >= max_segments:
                break

    if segments:
        return segments

    size_kb = len(data) / 1024
    first_window = sum(data[: min(4096, len(data))]) if data else 0
    middle_start = max((len(data) // 2) - 2048, 0)
    middle_window = sum(data[middle_start : middle_start + min(4096, len(data))]) if data else 0

    return [
        f"Processing {input_file.name} ({size_kb:.1f} KB) on {backend}.",
        "Running transcription through the local worker pipeline.",
        f"Binary profile markers: start={first_window % 997}, middle={middle_window % 997}.",
        "Generated provider-neutral transcript events for session persistence.",
    ]


def build_cuda_error_events(session_id: str) -> list[dict[str, object]]:
    return [
        {
            "type": "backend_state",
            "sessionId": session_id,
            "at": now_ms(),
            "state": "error",
            "detail": "local_gpu runtime check failed",
        },
        {
            "type": "error",
            "sessionId": session_id,
            "message": "CUDA runtime is unavailable for local_gpu. Switch to local_cpu or install CUDA dependencies.",
        },
    ]


def stream_local_file_events(
    session_id: str,
    backend: AsrBackend,
    source: SessionSource,
    input_file: Path,
    display_name: str,
    language: SessionLanguage,
) -> None:
    started = now_ms()
    emit_event(
        {
            "type": "session_started",
            "sessionId": session_id,
            "at": started,
            "source": source,
            "backend": backend,
        }
    )
    time.sleep(0.02)
    emit_event(
        {
            "type": "backend_state",
            "sessionId": session_id,
            "at": now_ms(),
            "state": "starting",
            "detail": f"{backend} worker booting for file transcription",
        }
    )
    time.sleep(0.02)

    model, model_name, device, compute_type, load_ms, cache_hit = load_whisper_model(backend)

    if load_ms > 0:
        emit_event(
            {
                "type": "backend_state",
                "sessionId": session_id,
                "at": now_ms(),
                "state": "running",
                "detail": f"loaded model={model_name} device={device} compute_type={compute_type} in {load_ms}ms (cached={cache_hit})",
            }
        )
        time.sleep(0.02)

    emit_event(
        {
            "type": "backend_state",
            "sessionId": session_id,
            "at": now_ms(),
            "state": "running",
            "detail": f"processing {display_name}",
        }
    )
    time.sleep(0.02)
    emit_event(
        {
            "type": "speech_start",
            "sessionId": session_id,
            "at": now_ms(),
        }
    )
    time.sleep(0.02)

    lang = language_arg(language)

    segments_generator, info = model.transcribe(str(input_file), language=lang, beam_size=5)

    duration_sec = info.duration
    log_debug(
        f"file transcription started session={session_id} backend={backend} "
        + f"language={lang or info.language}({info.language_probability:.2f}) duration={duration_sec}s"
    )

    seg_index = 0
    for segment in segments_generator:
        seg_index += 1
        text = segment.text.strip()
        if not text:
            continue

        segment_id = f"file-seg-{seg_index:03d}"
        start_ms = int(segment.start * 1000)
        end_ms = int(segment.end * 1000)

        emit_event(
            {
                "type": "final",
                "sessionId": session_id,
                "segmentId": segment_id,
                "text": text,
                "startMs": start_ms,
                "endMs": end_ms,
            }
        )
        time.sleep(0.02)

        if duration_sec > 0:
            progress = min(100, int((segment.end / duration_sec) * 100))
            emit_event(
                {
                    "type": "backend_state",
                    "sessionId": session_id,
                    "at": now_ms(),
                    "state": "running",
                    "detail": f"Transcribing... {progress}%",
                }
            )
            time.sleep(0.02)

    emit_event(
        {
            "type": "speech_end",
            "sessionId": session_id,
            "at": now_ms(),
        }
    )
    time.sleep(0.02)
    emit_event(
        {
            "type": "backend_state",
            "sessionId": session_id,
            "at": now_ms(),
            "state": "completed",
            "detail": f"{backend} file transcription finished",
        }
    )


def load_wav_pcm_mono(input_file: Path) -> tuple[np.ndarray, int, int]:
    with wave.open(str(input_file), "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_rate = wav_file.getframerate()
        sample_width = wav_file.getsampwidth()
        frames = wav_file.getnframes()
        raw = wav_file.readframes(frames)

    if sample_width == 1:
        data_u8 = np.frombuffer(raw, dtype=np.uint8)
        audio = (data_u8.astype(np.float32) - 128.0) / 128.0
    elif sample_width == 2:
        data_i16 = np.frombuffer(raw, dtype=np.int16)
        audio = data_i16.astype(np.float32) / 32768.0
    elif sample_width == 4:
        data_i32 = np.frombuffer(raw, dtype=np.int32)
        audio = data_i32.astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"unsupported sample width: {sample_width} bytes")

    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)

    return audio.astype(np.float32), sample_rate, channels


def parse_bool_flag(value: str) -> bool:
    lowered = value.strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"invalid bool flag: '{value}'")


def resolve_mic_vad_filter(vad_filter_arg: str | None) -> bool:
    if vad_filter_arg is not None:
        return parse_bool_flag(vad_filter_arg)

    env_value = os.environ.get("LUDO_MIC_VAD_FILTER")
    if env_value is not None:
        return parse_bool_flag(env_value)

    # Phase 1 default: disabled to avoid dropping short/quiet speech.
    return False


def audio_stats(audio: np.ndarray) -> tuple[float, float, float, float]:
    if audio.size == 0:
        return 0.0, 0.0, 0.0, 0.0

    min_amp = float(np.min(audio))
    max_amp = float(np.max(audio))
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float32), dtype=np.float32)))
    return min_amp, max_amp, rms, peak


def resample_audio_linear(audio: np.ndarray, source_sample_rate: int, target_sample_rate: int) -> np.ndarray:
    if audio.size == 0 or source_sample_rate <= 0 or source_sample_rate == target_sample_rate:
        return audio.astype(np.float32)

    source_len = audio.shape[0]
    target_len = max(1, int(round(source_len * (target_sample_rate / source_sample_rate))))

    source_positions = np.linspace(0.0, source_len - 1, num=source_len, dtype=np.float32)
    target_positions = np.linspace(0.0, source_len - 1, num=target_len, dtype=np.float32)
    resampled = np.interp(target_positions, source_positions, audio).astype(np.float32)
    return resampled


def normalize_audio_peak(audio: np.ndarray, target_peak: float = 0.90, max_gain: float = 16.0) -> np.ndarray:
    if audio.size == 0:
        return audio.astype(np.float32)

    peak = float(np.max(np.abs(audio)))
    if peak <= 1e-6:
        return audio.astype(np.float32)

    gain = min(max_gain, target_peak / peak)
    normalized = np.clip(audio * gain, -1.0, 1.0).astype(np.float32)
    return normalized


def resolve_model_runtime_config(backend: AsrBackend) -> tuple[str, str, str]:
    model_name = os.environ.get("LUDO_WHISPER_MODEL", "small")
    device = "cuda" if backend == "local_gpu" else "cpu"
    if backend == "local_gpu":
        compute_type = os.environ.get("LUDO_GPU_COMPUTE_TYPE", "float16")
    else:
        compute_type = "int8"
    return model_name, device, compute_type


def load_whisper_model(
    backend: AsrBackend,
) -> tuple[WhisperModel, str, str, str, int, bool]:
    if WhisperModel is None:
        raise RuntimeError(
            "faster-whisper is not installed in worker environment. Install dependencies in services/asr-worker-python."
        )

    model_name, device, compute_type = resolve_model_runtime_config(backend)
    cache_key = (backend, model_name)

    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key], model_name, device, compute_type, 0, True

    log_debug(
        f"loading faster-whisper model={model_name} device={device} compute_type={compute_type}"
    )
    load_started = time.perf_counter()
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    load_ms = int((time.perf_counter() - load_started) * 1000)
    log_debug(
        f"model-loaded model={model_name} device={device} compute_type={compute_type} loadMs={load_ms}"
    )
    _MODEL_CACHE[cache_key] = model
    return model, model_name, device, compute_type, load_ms, False


def language_arg(language: SessionLanguage) -> str | None:
    if language == "auto":
        return None
    return language


def build_mic_chunk_events(
    session_id: str,
    backend: AsrBackend,
    input_file: Path,
    chunk_index: int,
    language: SessionLanguage,
    sample_rate_hint: int,
    channels_hint: int,
    chunk_duration_ms: int,
    sample_count_hint: int,
    vad_filter: bool,
) -> tuple[list[dict[str, object]], dict[str, object]]:
    chunk_started = time.perf_counter()
    audio_raw, decoded_sample_rate, decoded_channels = load_wav_pcm_mono(input_file)
    raw_min, raw_max, raw_rms, raw_peak = audio_stats(audio_raw)

    audio_resampled = resample_audio_linear(
        audio=audio_raw,
        source_sample_rate=decoded_sample_rate,
        target_sample_rate=TARGET_SAMPLE_RATE,
    )
    resampled_min, resampled_max, resampled_rms, resampled_peak = audio_stats(audio_resampled)
    audio = normalize_audio_peak(audio_resampled)
    norm_min, norm_max, norm_rms, norm_peak = audio_stats(audio)

    model, model_name, device, compute_type, _, _ = load_whisper_model(backend)

    lang = language_arg(language)

    log_debug(
        "mic_chunk transcribe "
        + f"session={session_id} backend={backend} chunk={chunk_index} "
        + f"language={language} hint_sr={sample_rate_hint} hint_ch={channels_hint} "
        + f"hint_ms={chunk_duration_ms} hint_samples={sample_count_hint} "
        + f"decoded_sr={decoded_sample_rate} decoded_channels={decoded_channels} decoded_samples={audio_raw.shape[0]} "
        + f"resampled_sr={TARGET_SAMPLE_RATE} resampled_samples={audio_resampled.shape[0]} "
        + f"vad_filter={vad_filter} "
        + f"raw[min={raw_min:.5f} max={raw_max:.5f} rms={raw_rms:.5f} peak={raw_peak:.5f}] "
        + f"resampled[min={resampled_min:.5f} max={resampled_max:.5f} rms={resampled_rms:.5f} peak={resampled_peak:.5f}] "
        + f"normalized[min={norm_min:.5f} max={norm_max:.5f} rms={norm_rms:.5f} peak={norm_peak:.5f}] "
        + f"model={model_name} device={device} compute_type={compute_type}"
    )

    events: list[dict[str, object]] = [
        {
            "type": "backend_state",
            "sessionId": session_id,
            "at": now_ms(),
            "state": "running",
            "detail": (
                f"chunk={chunk_index} sr={sample_rate_hint} ch={channels_hint} "
                + f"durationMs={chunk_duration_ms} samples={sample_count_hint} lang={language} backend={backend} "
                + f"vad={vad_filter} rms={norm_rms:.5f} peak={norm_peak:.5f}"
            ),
        }
    ]

    segments, _ = model.transcribe(
        audio=audio,
        language=lang,
        vad_filter=vad_filter,
        beam_size=2,
        condition_on_previous_text=False,
    )

    segment_count = 0
    base_offset_ms = max(0, (chunk_index - 1) * chunk_duration_ms)

    for seg_index, segment in enumerate(segments, start=1):
        text = segment.text.strip()
        if not text:
            continue

        segment_count += 1
        seg_id = f"mic-seg-{chunk_index:05d}-{seg_index:02d}"
        interim_cut = max(10, int(len(text) * 0.66))
        interim_text = f"{text[:interim_cut]}..." if len(text) > interim_cut else text

        start_ms = base_offset_ms + int(segment.start * 1000)
        end_ms = base_offset_ms + int(segment.end * 1000)

        events.append(
            {
                "type": "interim",
                "sessionId": session_id,
                "segmentId": seg_id,
                "text": interim_text,
                "startMs": start_ms,
                "endMs": end_ms,
            }
        )
        events.append(
            {
                "type": "final",
                "sessionId": session_id,
                "segmentId": seg_id,
                "text": text,
                "startMs": start_ms,
                "endMs": end_ms,
            }
        )

    if segment_count == 0 and vad_filter:
        log_debug(f"chunk={chunk_index} produced no segments with vad_filter=True; retrying with vad_filter=False")
        segments_retry, _ = model.transcribe(
            audio=audio,
            language=lang,
            vad_filter=False,
            beam_size=2,
            condition_on_previous_text=False,
        )

        for seg_index, segment in enumerate(segments_retry, start=1):
            text = segment.text.strip()
            if not text:
                continue

            segment_count += 1
            seg_id = f"mic-seg-{chunk_index:05d}-rv{seg_index:02d}"
            interim_cut = max(10, int(len(text) * 0.66))
            interim_text = f"{text[:interim_cut]}..." if len(text) > interim_cut else text

            start_ms = base_offset_ms + int(segment.start * 1000)
            end_ms = base_offset_ms + int(segment.end * 1000)

            events.append(
                {
                    "type": "interim",
                    "sessionId": session_id,
                    "segmentId": seg_id,
                    "text": interim_text,
                    "startMs": start_ms,
                    "endMs": end_ms,
                }
            )
            events.append(
                {
                    "type": "final",
                    "sessionId": session_id,
                    "segmentId": seg_id,
                    "text": text,
                    "startMs": start_ms,
                    "endMs": end_ms,
                }
            )

    if segment_count == 0:
        events.append(
            {
                "type": "backend_state",
                "sessionId": session_id,
                "at": now_ms(),
                "state": "running",
                "detail": (
                    f"chunk={chunk_index} yielded no speech segments "
                    + f"(vad={vad_filter}, rms={norm_rms:.5f}, peak={norm_peak:.5f})"
                ),
            }
        )

    processing_ms = int((time.perf_counter() - chunk_started) * 1000)
    log_debug(
        f"mic_chunk complete session={session_id} chunk={chunk_index} processingMs={processing_ms} segments={segment_count}"
    )
    metrics: dict[str, object] = {
        "processingMs": processing_ms,
        "rms": round(norm_rms, 6),
        "peak": round(norm_peak, 6),
        "segmentCount": segment_count,
        "model": model_name,
        "device": device,
        "computeType": compute_type,
    }
    return events, metrics


def build_azure_placeholder_events(
    session_id: str, source: SessionSource, mode: WorkerMode
) -> list[dict[str, object]]:
    started = now_ms()
    message = "azure_server is not integrated yet. Use local_gpu or local_cpu for transcription."

    if mode == "mic_chunk":
        return [
            {
                "type": "backend_state",
                "sessionId": session_id,
                "at": started,
                "state": "error",
                "detail": "azure_server is a placeholder in this phase",
            },
            {
                "type": "error",
                "sessionId": session_id,
                "message": message,
            },
        ]

    return [
        {
            "type": "session_started",
            "sessionId": session_id,
            "at": started,
            "source": source,
            "backend": "azure_server",
        },
        {
            "type": "backend_state",
            "sessionId": session_id,
            "at": started + 60,
            "state": "error",
            "detail": "azure_server is a placeholder in this phase",
        },
        {
            "type": "error",
            "sessionId": session_id,
            "message": message,
        },
    ]


def emit_stream_message(payload: dict[str, object]) -> None:
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def coerce_optional_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return parse_bool_flag(value)
    return None


def run_mic_stream_loop(
    session_id: str,
    backend: AsrBackend,
    source: SessionSource,
    language: SessionLanguage,
    vad_filter_arg: str | None,
) -> int:
    if backend not in LOCAL_BACKENDS:
        emit_stream_message(
            {
                "kind": "fatal",
                "sessionId": session_id,
                "message": "azure_server is not available in local mic stream worker.",
            }
        )
        return 1

    started_perf = time.perf_counter()
    model, model_name, device, compute_type, model_load_ms, cache_hit = load_whisper_model(backend)
    startup_ms = int((time.perf_counter() - started_perf) * 1000)

    emit_stream_message(
        {
            "kind": "ready",
            "sessionId": session_id,
            "backend": backend,
            "source": source,
            "language": language,
            "model": model_name,
            "device": device,
            "computeType": compute_type,
            "modelLoadMs": model_load_ms,
            "startupMs": startup_ms,
            "fromCache": cache_hit,
        }
    )

    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue

        request_id = ""
        try:
            payload = json.loads(raw)
            request_id = str(payload.get("requestId", ""))
            request_type = str(payload.get("type", ""))

            if request_type == "stop":
                emit_stream_message(
                    {
                        "kind": "stopped",
                        "sessionId": session_id,
                        "requestId": request_id,
                    }
                )
                return 0

            if request_type != "transcribe_chunk":
                emit_stream_message(
                    {
                        "kind": "chunk_error",
                        "sessionId": session_id,
                        "requestId": request_id,
                        "message": f"unsupported stream request type '{request_type}'",
                    }
                )
                continue

            input_file_raw = payload.get("inputFile")
            if not isinstance(input_file_raw, str) or not input_file_raw:
                raise ValueError("transcribe_chunk requires non-empty inputFile")

            input_file = Path(input_file_raw)
            if not input_file.exists():
                raise FileNotFoundError(f"chunk file does not exist: {input_file}")

            request_language = payload.get("language", language)
            if request_language not in {"ko", "en", "auto"}:
                raise ValueError(
                    f"unsupported language '{request_language}'. expected ko, en, or auto"
                )

            request_vad = coerce_optional_bool(payload.get("vadFilter"))
            if request_vad is None:
                request_vad = resolve_mic_vad_filter(vad_filter_arg)

            chunk_index = int(payload.get("chunkIndex") or 0)
            sample_rate = int(payload.get("sampleRate") or 0)
            channels = int(payload.get("channels") or 0)
            chunk_duration_ms = int(payload.get("chunkDurationMs") or 0)
            sample_count = int(payload.get("sampleCount") or 0)

            events, metrics = build_mic_chunk_events(
                session_id=session_id,
                backend=backend,
                input_file=input_file,
                chunk_index=chunk_index,
                language=request_language,
                sample_rate_hint=sample_rate,
                channels_hint=channels,
                chunk_duration_ms=chunk_duration_ms,
                sample_count_hint=sample_count,
                vad_filter=request_vad,
            )

            emit_stream_message(
                {
                    "kind": "chunk_result",
                    "sessionId": session_id,
                    "requestId": request_id,
                    "events": events,
                    "metrics": metrics,
                    "backend": backend,
                    "device": device,
                    "computeType": compute_type,
                }
            )
        except Exception as error:
            emit_stream_message(
                {
                    "kind": "chunk_error",
                    "sessionId": session_id,
                    "requestId": request_id,
                    "message": str(error),
                }
            )

    log_debug(f"mic_stream stdin closed for session={session_id}")
    return 0


def run_sys_audio_stream_loop(
    session_id: str,
    backend: AsrBackend,
    source: SessionSource,
    language: SessionLanguage,
    vad_filter_arg: str | None,
    output_dir: Path | None,
) -> int:
    if sc is None:
        emit_stream_message(
            {
                "kind": "fatal",
                "sessionId": session_id,
                "message": "soundcard library is missing. Cannot capture system audio.",
            }
        )
        return 1

    if backend not in LOCAL_BACKENDS:
        emit_stream_message(
            {
                "kind": "fatal",
                "sessionId": session_id,
                "message": "azure_server is not available in local stream worker.",
            }
        )
        return 1

    started_perf = time.perf_counter()
    model, model_name, device, compute_type, model_load_ms, cache_hit = load_whisper_model(backend)
    startup_ms = int((time.perf_counter() - started_perf) * 1000)

    emit_stream_message(
        {
            "kind": "ready",
            "sessionId": session_id,
            "backend": backend,
            "source": source,
            "language": language,
            "model": model_name,
            "device": device,
            "computeType": compute_type,
            "modelLoadMs": model_load_ms,
            "startupMs": startup_ms,
            "fromCache": cache_hit,
        }
    )

    stop_event = threading.Event()
    def stdin_listener():
        for line in sys.stdin:
            try:
                payload = json.loads(line.strip())
                if payload.get("type") == "stop":
                    stop_event.set()
                    break
            except Exception:
                pass
    
    t = threading.Thread(target=stdin_listener, daemon=True)
    t.start()

    speaker = sc.default_speaker()
    mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)

    chunk_duration_sec = 2.0
    vad_filter = resolve_mic_vad_filter(vad_filter_arg)
    lang = language_arg(language)

    if output_dir:
        raw_dir = output_dir / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        full_audio_path = raw_dir / "full_session.wav"
        wav_file = wave.open(str(full_audio_path), "wb")
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(TARGET_SAMPLE_RATE)
    else:
        wav_file = None

    chunk_index = 0
    try:
        with mic.recorder(samplerate=TARGET_SAMPLE_RATE) as recorder:
            while not stop_event.is_set():
                chunk_index += 1
                chunk_started = time.perf_counter()
                
                audio_data = recorder.record(numframes=int(TARGET_SAMPLE_RATE * chunk_duration_sec))
                
                if len(audio_data.shape) > 1 and audio_data.shape[1] > 1:
                    mono_audio = np.mean(audio_data, axis=1, dtype=np.float32)
                else:
                    mono_audio = audio_data.flatten()
                
                if wav_file:
                    i16_audio = (mono_audio * 32767).astype(np.int16)
                    wav_file.writeframes(i16_audio.tobytes())

                # Transcribe
                norm_audio = normalize_audio_peak(mono_audio)
                norm_min, norm_max, norm_rms, norm_peak = audio_stats(norm_audio)

                events = [
                    {
                        "type": "backend_state",
                        "sessionId": session_id,
                        "at": now_ms(),
                        "state": "running",
                        "detail": f"sys_chunk={chunk_index} rms={norm_rms:.5f} peak={norm_peak:.5f}",
                    }
                ]

                segments, _ = model.transcribe(
                    audio=norm_audio,
                    language=lang,
                    vad_filter=vad_filter,
                    beam_size=2,
                    condition_on_previous_text=False,
                )

                segment_count = 0
                base_offset_ms = int((chunk_index - 1) * chunk_duration_sec * 1000)

                for seg_index, segment in enumerate(segments, start=1):
                    text = segment.text.strip()
                    if not text:
                        continue

                    segment_count += 1
                    seg_id = f"sys-seg-{chunk_index:05d}-{seg_index:02d}"
                    interim_cut = max(10, int(len(text) * 0.66))
                    interim_text = f"{text[:interim_cut]}..." if len(text) > interim_cut else text

                    start_ms = base_offset_ms + int(segment.start * 1000)
                    end_ms = base_offset_ms + int(segment.end * 1000)

                    events.append({
                        "type": "interim",
                        "sessionId": session_id,
                        "segmentId": seg_id,
                        "text": interim_text,
                        "startMs": start_ms,
                        "endMs": end_ms,
                    })
                    events.append({
                        "type": "final",
                        "sessionId": session_id,
                        "segmentId": seg_id,
                        "text": text,
                        "startMs": start_ms,
                        "endMs": end_ms,
                    })

                if segment_count == 0:
                    events.append({
                        "type": "backend_state",
                        "sessionId": session_id,
                        "at": now_ms(),
                        "state": "running",
                        "detail": f"sys_chunk={chunk_index} no speech",
                    })

                processing_ms = int((time.perf_counter() - chunk_started) * 1000)
                metrics = {
                    "processingMs": processing_ms,
                    "rms": round(norm_rms, 6),
                    "peak": round(norm_peak, 6),
                    "segmentCount": segment_count,
                    "model": model_name,
                    "device": device,
                    "computeType": compute_type,
                }

                emit_stream_message(
                    {
                        "kind": "chunk_result",
                        "sessionId": session_id,
                        "requestId": f"sys-{chunk_index}",
                        "events": events,
                        "metrics": metrics,
                        "backend": backend,
                        "device": device,
                        "computeType": compute_type,
                    }
                )

    except Exception as error:
        log_debug(f"sys_audio_stream loop error: {error}")
    finally:
        if wav_file:
            wav_file.close()

    emit_stream_message(
        {
            "kind": "stopped",
            "sessionId": session_id,
            "requestId": "sys_stop",
        }
    )
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LUDO worker")
    parser.add_argument("--mode", default="file", choices=["file", "mic_chunk", "mic_stream", "sys_audio_stream"])
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--backend", required=True, choices=["local_gpu", "local_cpu", "azure_server"])
    parser.add_argument("--source", default="file", choices=["mic", "system", "file"])
    parser.add_argument("--language", default="auto", choices=["ko", "en", "auto"])
    parser.add_argument("--input-file", required=False)
    parser.add_argument("--file-name", required=False)
    parser.add_argument("--chunk-index", type=int, required=False)
    parser.add_argument("--mime-type", required=False)
    parser.add_argument("--sample-rate", type=int, required=False)
    parser.add_argument("--channels", type=int, required=False)
    parser.add_argument("--chunk-duration-ms", type=int, required=False)
    parser.add_argument("--sample-count", type=int, required=False)
    parser.add_argument("--vad-filter", required=False, choices=["true", "false"])
    parser.add_argument("--output-dir", required=False)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    mode: WorkerMode = args.mode
    session_id: str = args.session_id
    backend: AsrBackend = args.backend
    source: SessionSource = args.source
    language: SessionLanguage = args.language
    output_dir = Path(args.output_dir) if args.output_dir else None

    if mode == "sys_audio_stream":
        try:
            if backend == "local_gpu":
                patched_dirs = configure_windows_gpu_dll_dirs()
                if patched_dirs:
                    log_debug(f"local_gpu dll directories patched: {' | '.join(patched_dirs)}")
                else:
                    log_debug("local_gpu dll directory patch found no candidate directories")

                cuda_ok, detail = detect_cuda_runtime()
                log_debug(f"cuda_check backend={backend} result={cuda_ok} detail={detail}")
                if not cuda_ok:
                    emit_stream_message(
                        {
                            "kind": "fatal",
                            "sessionId": session_id,
                            "message": "CUDA runtime is unavailable for local_gpu. Switch to local_cpu or install CUDA dependencies.",
                        }
                    )
                    sys.exit(1)

            exit_code = run_sys_audio_stream_loop(
                session_id=session_id,
                backend=backend,
                source=source,
                language=language,
                vad_filter_arg=args.vad_filter,
                output_dir=output_dir,
            )
            sys.exit(exit_code)
        except Exception as error:
            emit_stream_message(
                {
                    "kind": "fatal",
                    "sessionId": session_id,
                    "message": f"worker stream fatal error: {error}",
                }
            )
            sys.exit(1)

    if mode == "mic_stream":
        try:
            if backend == "local_gpu":
                patched_dirs = configure_windows_gpu_dll_dirs()
                if patched_dirs:
                    log_debug(f"local_gpu dll directories patched: {' | '.join(patched_dirs)}")
                else:
                    log_debug("local_gpu dll directory patch found no candidate directories")

                cuda_ok, detail = detect_cuda_runtime()
                log_debug(f"cuda_check backend={backend} result={cuda_ok} detail={detail}")
                if not cuda_ok:
                    emit_stream_message(
                        {
                            "kind": "fatal",
                            "sessionId": session_id,
                            "message": "CUDA runtime is unavailable for local_gpu. Switch to local_cpu or install CUDA dependencies.",
                        }
                    )
                    sys.exit(1)

            exit_code = run_mic_stream_loop(
                session_id=session_id,
                backend=backend,
                source=source,
                language=language,
                vad_filter_arg=args.vad_filter,
            )
            sys.exit(exit_code)
        except Exception as error:
            emit_stream_message(
                {
                    "kind": "fatal",
                    "sessionId": session_id,
                    "message": f"worker stream fatal error: {error}",
                }
            )
            sys.exit(1)

    if not args.input_file:
        emit_event(
            {
                "type": "error",
                "sessionId": session_id,
                "message": "input file is required for this worker mode",
            }
        )
        return

    input_file = Path(args.input_file)
    file_name = args.file_name or input_file.name

    if not input_file.exists():
        emit_event(
            {
                "type": "error",
                "sessionId": session_id,
                "message": f"input file not found: {input_file}",
            }
        )
        return

    if backend == "local_gpu":
        patched_dirs = configure_windows_gpu_dll_dirs()
        if patched_dirs:
            log_debug(f"local_gpu dll directories patched: {' | '.join(patched_dirs)}")
        else:
            log_debug("local_gpu dll directory patch found no candidate directories")

        cuda_ok, detail = detect_cuda_runtime()
        log_debug(f"cuda_check backend={backend} result={cuda_ok} detail={detail}")
        if not cuda_ok:
            for event in build_cuda_error_events(session_id=session_id):
                emit_event(event)
            return

    try:
        if backend not in LOCAL_BACKENDS:
            events = build_azure_placeholder_events(session_id=session_id, source=source, mode=mode)
        elif mode == "mic_chunk":
            chunk_index = args.chunk_index or 0
            sample_rate_hint = args.sample_rate or 0
            channels_hint = args.channels or 0
            chunk_duration_ms = args.chunk_duration_ms or 0
            sample_count_hint = args.sample_count or 0
            vad_filter = resolve_mic_vad_filter(args.vad_filter)

            events, _ = build_mic_chunk_events(
                session_id=session_id,
                backend=backend,
                input_file=input_file,
                chunk_index=chunk_index,
                language=language,
                sample_rate_hint=sample_rate_hint,
                channels_hint=channels_hint,
                chunk_duration_ms=chunk_duration_ms,
                sample_count_hint=sample_count_hint,
                vad_filter=vad_filter,
            )
        else:
            stream_local_file_events(
                session_id=session_id,
                backend=backend,
                source=source,
                input_file=input_file,
                display_name=file_name,
                language=language,
            )

    except Exception as error:
        emit_event(
            {
                "type": "error",
                "sessionId": session_id,
                "message": f"worker transcription error: {error}",
            }
        )


if __name__ == "__main__":
    main()
