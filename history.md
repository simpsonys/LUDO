# LUDO AI Agent History

## Current Goal
Fix UI auto-scrolling issues that made the stop button unclickable, and resolve the frozen stop button caused by a deadlock in the Tauri IPC.

## Completed Steps
- [x] Initialized architecture planning
- [x] 1. Update `services/asr-worker-python/pyproject.toml` to include `soundcard` dependency.
- [x] 2. Update `worker.py` to add `sys_audio_stream` mode capturing WASAPI loopback audio.
- [x] 3. Ensure `worker.py` in `sys_audio_stream` mode saves full session audio to `raw/full_session.wav`.
- [x] 4. Update `apps/client-tauri/src/asr/microphonePipeline.ts` (or `backendAdapter.ts` / `App.tsx`) to start the `sys_audio_stream` worker and handle events, instead of using `getDisplayMedia`.
- [x] 5. Update `lib.rs` and `pythonWorkerClient.ts` if a new Tauri command or updated struct is needed.
- [x] 6. Fixed Python `argparse` missing `sys_audio_stream` choice which caused immediate silent crash on launch.
- [x] 7. Fixed Rust compilation issue (duplicate struct).
- [x] 8. Fixed UI auto-scrolling by switching from `scrollIntoView()` to setting `scrollTop = scrollHeight` on the container, preventing the entire window from moving.
- [x] 9. Fixed UI frozen stop button by dropping the Mutex lock in `poll_sys_audio_events` before blocking on stdout, preventing a deadlock with `stopPythonMicrophoneWorker`.
- [x] 10. Verify end-to-end functionality via CLI and `cargo check`.

## Pending Steps
- [ ] RAG and Artifact generation (next phases)

## Exact Next Action
Complete current task and prompt user to test.

## Last Updated
2026-04-23

## Current Agent
Code

## Working Branch
main

## Relevant Files
- `apps/client-tauri/src/App.tsx`
- `apps/client-tauri/src-tauri/src/lib.rs`
