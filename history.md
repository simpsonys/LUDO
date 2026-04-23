# LUDO AI Agent History

## Current Goal
Implement native Windows system audio capture using `soundcard` library in Python worker, bypassing frontend `getDisplayMedia` to improve stability and keep audio processing in the native layer.

## Completed Steps
- [x] Initialized architecture planning

## Pending Steps
- [ ] 1. Update `services/asr-worker-python/pyproject.toml` to include `soundcard` dependency.
- [ ] 2. Update `worker.py` to add `sys_audio_stream` mode capturing WASAPI loopback audio.
- [ ] 3. Ensure `worker.py` in `sys_audio_stream` mode saves full session audio to `raw/full_session.wav`.
- [ ] 4. Update `apps/client-tauri/src/asr/microphonePipeline.ts` (or `backendAdapter.ts` / `App.tsx`) to start the `sys_audio_stream` worker and handle events, instead of using `getDisplayMedia`.
- [ ] 5. Update `lib.rs` and `pythonWorkerClient.ts` if a new Tauri command or updated struct is needed.
- [ ] 6. Build and verify end-to-end functionality.

## Exact Next Action
Switch to `code` mode to start modifying `pyproject.toml` and Python worker code.

## Last Updated
2026-04-23

## Current Agent
Gemini Pro (Architect) -> Switching to Code

## Working Branch
main

## Relevant Files
- `services/asr-worker-python/pyproject.toml`
- `services/asr-worker-python/src/asr_worker_python/worker.py`
- `apps/client-tauri/src/asr/microphonePipeline.ts`
- `apps/client-tauri/src-tauri/src/lib.rs`
- `apps/client-tauri/src/asr/pythonWorkerClient.ts`
