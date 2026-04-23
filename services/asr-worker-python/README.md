# LUDO ASR Worker (Python)

Early Phase 1 local file-transcription worker.

Current status:
- command-line worker contract is active
- file-transcription event flow is implemented for local backends
- microphone chunk transcription flow is implemented for local backends
- microphone chunks use real faster-whisper inference
- file mode still uses staged local analysis output (microphone mode uses real ASR)

Design direction:
- desktop local-first worker for GPU/CPU backends
- server backend remains Azure-first but provider-abstracted in app contracts
- worker emits provider-neutral transcript event semantics
- backend mode naming aligned with shared schema:
  - `local_gpu`
  - `local_cpu`
  - `azure_server`

## Local run

```bash
python -m pip install -e .
ludo-asr-worker --session-id demo --backend local_cpu --source file --input-file ./sample.wav
```

Microphone chunk mode example:

```bash
python -m asr_worker_python.worker --mode mic_chunk --session-id mic-demo --backend local_cpu --source mic --language ko --input-file ./chunk.wav --chunk-index 1 --sample-rate 48000 --channels 1 --chunk-duration-ms 2500 --sample-count 120000
```

## Next phase candidates

1. define stdin/stdout or websocket event transport
2. add faster-whisper runtime probing
3. implement incremental interim/final emission
4. keep a warm persistent worker process for microphone mode (avoid per-chunk model reload)
5. expose health and capability checks
