from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path
from threading import Event
from typing import Any

import azure.cognitiveservices.speech as speechsdk
import uvicorn
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

app = FastAPI(title="LUDO Azure-first ASR Gateway", version="0.1.0")


def now_ms() -> int:
    return int(time.time() * 1000)


def resolve_azure_credentials(x_api_key: str | None) -> tuple[str, str]:
    speech_key = os.environ.get("LUDO_AZURE_SPEECH_KEY") or x_api_key
    speech_region = os.environ.get("LUDO_AZURE_SPEECH_REGION")

    if not speech_key:
        raise HTTPException(
            status_code=503,
            detail="Azure Speech key is not configured. Set LUDO_AZURE_SPEECH_KEY or provide x-api-key.",
        )

    if not speech_region:
        raise HTTPException(
            status_code=503,
            detail="Azure Speech region is not configured. Set LUDO_AZURE_SPEECH_REGION.",
        )

    return speech_key, speech_region


def map_language(language: str) -> str:
    normalized = (language or "auto").strip().lower()
    if normalized == "ko":
        return "ko-KR"
    if normalized == "en":
        return "en-US"

    return os.environ.get("LUDO_AZURE_DEFAULT_LANGUAGE", "ko-KR")


def azure_offset_to_ms(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(int(value) / 10_000)
    except Exception:
        return None


def azure_duration_to_ms(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(int(value) / 10_000)
    except Exception:
        return None


def transcribe_file_continuous(
    file_path: Path,
    speech_key: str,
    speech_region: str,
    language: str,
) -> list[dict[str, Any]]:
    speech_config = speechsdk.SpeechConfig(subscription=speech_key, region=speech_region)
    speech_config.speech_recognition_language = language
    audio_config = speechsdk.audio.AudioConfig(filename=str(file_path))
    recognizer = speechsdk.SpeechRecognizer(speech_config=speech_config, audio_config=audio_config)

    events: list[dict[str, Any]] = []
    finished = Event()
    cancel_detail: str | None = None

    def on_recognizing(evt: Any) -> None:
        text = evt.result.text if evt and evt.result else ""
        if not text:
            return
        events.append(
            {
                "kind": "interim",
                "text": text,
                "offsetMs": azure_offset_to_ms(getattr(evt.result, "offset", None)),
                "durationMs": azure_duration_to_ms(getattr(evt.result, "duration", None)),
                "id": getattr(evt.result, "result_id", None),
            }
        )

    def on_recognized(evt: Any) -> None:
        text = evt.result.text if evt and evt.result else ""
        if not text:
            return
        events.append(
            {
                "kind": "final",
                "text": text,
                "offsetMs": azure_offset_to_ms(getattr(evt.result, "offset", None)),
                "durationMs": azure_duration_to_ms(getattr(evt.result, "duration", None)),
                "id": getattr(evt.result, "result_id", None),
            }
        )

    def on_canceled(evt: Any) -> None:
        nonlocal cancel_detail
        detail = None
        if evt and evt.result:
            detail = getattr(evt.result, "cancellation_details", None)
        cancel_detail = str(detail) if detail else "Azure Speech canceled the recognition session."
        finished.set()

    def on_session_stopped(_: Any) -> None:
        finished.set()

    recognizer.recognizing.connect(on_recognizing)
    recognizer.recognized.connect(on_recognized)
    recognizer.canceled.connect(on_canceled)
    recognizer.session_stopped.connect(on_session_stopped)

    recognizer.start_continuous_recognition()
    timeout_sec = float(os.environ.get("LUDO_AZURE_FILE_TIMEOUT_SEC", "120"))
    finished.wait(timeout=timeout_sec)
    recognizer.stop_continuous_recognition()

    if cancel_detail:
        raise RuntimeError(cancel_detail)

    return events


def transcribe_chunk_once(
    file_path: Path,
    speech_key: str,
    speech_region: str,
    language: str,
) -> list[dict[str, Any]]:
    speech_config = speechsdk.SpeechConfig(subscription=speech_key, region=speech_region)
    speech_config.speech_recognition_language = language
    audio_config = speechsdk.audio.AudioConfig(filename=str(file_path))
    recognizer = speechsdk.SpeechRecognizer(speech_config=speech_config, audio_config=audio_config)

    result = recognizer.recognize_once()
    text = result.text if result else ""
    if not text:
        return []

    return [
        {
            "kind": "final",
            "text": text,
            "offsetMs": azure_offset_to_ms(getattr(result, "offset", None)),
            "durationMs": azure_duration_to_ms(getattr(result, "duration", None)),
            "id": getattr(result, "result_id", None),
        }
    ]


def save_upload_to_temp(upload: UploadFile, suffix: str) -> Path:
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as handle:
        data = upload.file.read()
        handle.write(data)
        return Path(handle.name)


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    has_key = bool(os.environ.get("LUDO_AZURE_SPEECH_KEY"))
    has_region = bool(os.environ.get("LUDO_AZURE_SPEECH_REGION"))
    return {
        "ok": True,
        "azureConfigured": has_key and has_region,
        "timeMs": now_ms(),
    }


@app.post("/v1/asr/azure/file-transcriptions")
async def azure_file_transcriptions(
    file: UploadFile = File(...),
    sessionId: str = Form(...),  # noqa: N803
    language: str = Form("auto"),
    x_api_key: str | None = Header(default=None),
) -> dict[str, Any]:
    speech_key, speech_region = resolve_azure_credentials(x_api_key)
    mapped_language = map_language(language)

    suffix = Path(file.filename or "input.wav").suffix or ".wav"
    temp_path = save_upload_to_temp(file, suffix=suffix)

    try:
        events = transcribe_file_continuous(
            file_path=temp_path,
            speech_key=speech_key,
            speech_region=speech_region,
            language=mapped_language,
        )
        return {
            "sessionId": sessionId,
            "provider": "azure",
            "events": events,
        }
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail=f"Azure file transcription failed: {error}",
        ) from error
    finally:
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)


@app.post("/v1/asr/azure/microphone-chunks")
async def azure_microphone_chunks(
    audio: UploadFile = File(...),
    sessionId: str = Form(...),  # noqa: N803
    chunkIndex: int = Form(...),  # noqa: N803
    language: str = Form("auto"),
    x_api_key: str | None = Header(default=None),
) -> dict[str, Any]:
    speech_key, speech_region = resolve_azure_credentials(x_api_key)
    mapped_language = map_language(language)

    suffix = Path(audio.filename or "chunk.wav").suffix or ".wav"
    temp_path = save_upload_to_temp(audio, suffix=suffix)

    try:
        events = transcribe_chunk_once(
            file_path=temp_path,
            speech_key=speech_key,
            speech_region=speech_region,
            language=mapped_language,
        )
        return {
            "sessionId": sessionId,
            "chunkIndex": chunkIndex,
            "provider": "azure",
            "events": events,
        }
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail=f"Azure microphone chunk transcription failed: {error}",
        ) from error
    finally:
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)


def run() -> None:
    host = os.environ.get("LUDO_ASR_SERVER_HOST", "127.0.0.1")
    port = int(os.environ.get("LUDO_ASR_SERVER_PORT", "8080"))
    uvicorn.run("asr_server_python.main:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    run()

