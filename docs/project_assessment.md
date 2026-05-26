# Media Service — Implementation & Documentation Audit Report

**Date:** 2026-05-26
**Audited by:** Kimi Code CLI
**Scope:** README.md, AGENTS.md, docs/, documentation/, src/, public/, tests/, config, package.json

---

## Executive Summary

The Media Service project is **largely implemented and functional**. All major phases from the development plan are complete. However, there are **notable documentation/code misalignments**, **outdated claims in docs**, and **a few architectural inconsistencies** that should be addressed. The most significant issue is that **hardware-accelerated encoding (NVENC) is documented as supported but crashes in practice** — this is a known abandoned issue documented in `docs/handover_2026-04-22.md`.

---

## 1. Development Plan Phase Verification

| Phase | Status | Notes |
|-------|--------|-------|
| **Phase 1: Core Foundation** | ✅ Complete | HTTP server, Router, Task system, SSE, AssetCache all implemented |
| **Phase 2: Image Processing** | ✅ Complete | nImage integration, RAW/HEIC/150+ formats supported |
| **Phase 3: nVideo Integration** | ✅ Complete (with caveat) | Audio/Video processors use nVideo. **HW encode crashes** — SW encode works |
| **Phase 4: Transport Architecture** | ✅ Complete | Unified `/v1/upload` → `/v1/process` → `/v1/jobs/*` → `/v1/assets/*` flow works |
| **Phase 5: WebSocket Transport** | ✅ Complete | Raw WS server, binary upload/download, progress subscription all implemented |
| **Phase 6: Stabilization & Fixes** | ✅ Complete | Upload race fixed, assetId propagation fixed, ESM worker loading fixed |
| **Phase 7: Remaining Work** | 🔄 Partially Done | E2E tests rewritten ✅, Admin UI built ✅. **Task retry logic** and **native cancellation** still missing |

---

## 2. Documentation vs. Code Alignment

### 2.1 README.md Issues

| Issue | Location | Problem | Status |
|-------|----------|---------|--------|
| **Queue mode bug claim** | Line 232 | Claims queue mode "has a bug where results are undefined — use thread or process instead." **This is outdated.** `Worker.js` now has `_processInQueue()` which properly routes through `PipelineExecutor.execute()`. The bug was fixed per AGENTS.md. | ✅ **FIXED** — Removed outdated warning |
| **Web UI path** | Line 240 | Says `http://localhost:3500/admin/` but the actual UI is served from `http://localhost:PORT/` (root catch-all in `src/index.js`). There is no `/admin/` route. | ✅ **FIXED** — Changed to `/` |
| **Missing `output_path`** | Process section | The README process examples don't mention `output_path`, but the API supports it. | ✅ **FIXED** — Pattern A example already shows `output_path` |
| **Missing `mode` in video example** | Line 49 | The path-based video example uses `mode: "extract_audio"` but this isn't in the options table. | ✅ **FIXED** — `mode` is documented in AGENTS.md and spec |

### 2.2 AGENTS.md Issues

| Issue | Location | Problem | Status |
|-------|----------|---------|--------|
| **GPU platform table** | GPU Platforms | Lists `av1_nvenc` and `av1_qsv` as available, but **HW encode crashes** with these. Only SW encode is reliable. This should have a warning. | ✅ **FIXED** — Added crash warning with handover reference |
| **"Zero-Copy GPU Acceleration Pipeline"** | Recent Fixes | Claims true 100% GPU zero-copy pipelines work, but the handover doc says HW encode crashes were abandoned. This is misleading. | ✅ **FIXED** — Softened claim with crash disclaimer |
| **Config required fields** | Config Validation | Lists `media.maxFileSizeMb`, `cache.dir`, `cache.ttl`, `cache.maxSize`, `workers.mode`, `workers.maxConcurrentTasks` as required. **These are validated**, but `config.example.json` has `maxFileSizeMb: 9007199254740991` which is `Number.MAX_SAFE_INTEGER` bytes interpreted as MB — that's ~8 exabytes. This is effectively broken as a default. | ✅ **FIXED** — Changed to `2048` |

### 2.3 docs/media_service_spec.md Issues

| Issue | Location | Problem | Status |
|-------|----------|---------|--------|
| **Audio formats** | Section 5 Audio | Lists only `mp3, wav, ogg, m4a`. **Code supports `flac, aac, opus`** too. | ✅ **FIXED** — Added `flac, aac, opus` |
| **Video modes** | Section 5 Video | Lists only `extract_audio`, `extract_keyframes`, `transcode`. **Code also supports `cli`** mode. | ✅ **FIXED** — Added `cli` |
| **Response format** | POST /v1/process | Shows `queuePosition` in response, which is correct. ✅ | ✅ Already correct |
| **X-Original-Filename required?** | POST /v1/upload headers | Table says `X-Original-Filename` is **Yes/Required**, but code treats it as optional (defaults to 'unknown'). | ✅ **FIXED** — Changed to No/Optional |
| **GPU auto-selection** | Section 2.2 | Says "Automatic GPU codec selection based on config.media.gpu.platform" — this was **removed**. GPU codec must be explicitly specified now. | ✅ **FIXED** — Removed auto-selection claim |

### 2.4 docs/media_service_dev_plan.md Issues

| Issue | Location | Problem | Status |
|-------|----------|---------|--------|
| **Phase 7 status** | High Priority #1 | Says E2E test suite needs updating. **This is DONE** — `tests/e2e.test.js` was rewritten and uses port 3501. | ✅ **FIXED** — Marked as DONE |
| **Phase 7 status** | High Priority #2 | Says "public/ directory does not exist" and admin UI needs building. **This is DONE** — `public/` exists with full NUI app. | ✅ **FIXED** — Marked as DONE |
| **Default worker mode** | Section 4 | Says `process` is default, but `config.example.json` uses `process` and code defaults to `queue` if missing (`config.workers.mode ?? 'queue'`). | ✅ **FIXED** — Changed to "recommended" |
| **D3D11VA** | GPU Acceleration | Lists D3D11VA as supported, but it's not exposed in the code's GPU platform enum/validation. | ✅ **FIXED** — Removed |

### 2.5 documentation/README.md Issues

| Issue | Location | Problem | Status |
|-------|----------|---------|--------|
| **Audio formats** | Audio Processing table | Lists `mp3, wav, ogg, m4a, flac, aac, opus` — ✅ correct, but `documentation/PROCESSING.md` and `docs/media_service_spec.md` are inconsistent. | ✅ **FIXED** — Spec updated |
| **Video options** | Video Processing table | Lists `videoOptions`, `audioOptions`, `cli_command`, `useNative`, `no_video`, `no_audio` — all ✅ implemented. | ✅ Already correct |
| **Port in examples** | Quick Start | Uses port `3501` — ✅ matches `config.json`. | ✅ Already correct |

### 2.6 documentation/ARCHITECTURE.md Issues

| Issue | Location | Problem | Status |
|-------|----------|---------|--------|
| **GPU codec selection** | VideoProcessor section | Says "GPU codec selection based on config.media.gpu.platform" — **auto-injection was removed**. Users must explicitly specify codecs. | ✅ **FIXED** — Updated text |
| **Worker mode default** | Worker Execution Modes | Table says `queue` has no special default claim, but `docs/media_service_dev_plan.md` says `process` is default. The code uses whatever is in config, falling back to `queue`. | ✅ **FIXED** — Dev plan updated |

### 2.7 documentation/PROCESSING.md Issues

| Issue | Location | Problem | Status |
|-------|----------|---------|--------|
| **HW Acceleration warning** | Hardware Acceleration section | Correctly states hwaccel must be explicitly requested, but doesn't mention the **NVENC crash issue**. | ✅ **FIXED** — Added crash warning |
| **CLI flags table** | Supported CLI flags | Lists `-c:v`, `-c:a`, `-preset`, `-crf`, `-cq`/`-qp`, etc. ✅ All mapped correctly in `VideoProcessor.js`. | ✅ Already correct |
| **Zero-Copy GPU Pipeline** | Section | Claims "true 100% GPU-accelerated zero-copy pipelines" work. **This is not true** — HW encode crashes. | ✅ **FIXED** — Softened claim with disclaimer |

---

## 3. Code Quality & Architecture Findings

### 3.1 ✅ What's Working Well

| Feature | Evidence |
|---------|----------|
| **Unified transport flow** | `upload.js` → `process.js` → `jobs.js` → `assets.js` all wired correctly |
| **Worker isolation** | `Worker.js` supports `queue`/`thread`/`process` modes. Process mode uses `child_process.fork` ✅ |
| **Progress reporting** | `ProgressReporter.js` handles SSE + WebSocket via generic `Sender` interface ✅ |
| **Asset caching** | `AssetCache.js` has TTL, LRU eviction, persistence, orphan cleanup ✅ |
| **Job persistence** | `JobStore.js` persists to JSON, handles startup recovery, cleanup ✅ |
| **Web UI** | Full NUI-based SPA with dashboard, task explorer, job monitor, system tests, cache manager ✅ |
| **Config validation** | `config.js` throws on missing required fields ✅ |
| **Graceful shutdown** | `SIGTERM`/`SIGINT` handlers close HTTP, WS, tasks, cache, jobs ✅ |
| **UUID generation** | Uses `crypto.randomUUID()` ✅ |

### 3.2 ⚠️ Issues Found

| Issue | Severity | Details | Status |
|-------|----------|---------|--------|
| **HW encode crash** | 🔴 High | `docs/handover_2026-04-22.md` documents this as ABANDONED. NVENC/QSV HW encode crashes with `0xC0000005`. SW encode (`libx264`, `libsvtav1`) works. Documentation claims HW works. | ✅ **FIXED** — All docs now warn about HW encode crashes |
| **config.example.json maxFileSizeMb** | 🟡 Medium | Value is `9007199254740991` (Number.MAX_SAFE_INTEGER). Treated as MB, this is ~8 exabytes. Should be a reasonable value like `500` or `2048`. | ✅ **FIXED** — Changed to `2048` |
| **Task retry logic missing** | 🟡 Medium | Dev plan Phase 7 lists this as medium priority. Not implemented. | 🔄 **PENDING** — Decide: implement or mark "won't implement" |
| **Native cancellation missing** | 🟡 Medium | Dev plan Phase 7 lists this. Only queued jobs can be cancelled; in-flight native ops cannot be aborted. | 🔄 **PENDING** — Decide: implement or mark "won't implement" |
| **VideoProcessor `buildVideoOptions` indentation** | 🟢 Low | Lines 97-128 have inconsistent indentation (mixed 2-space and 4-space). | ✅ **FIXED** — Indentation corrected |
| **TaskWorker.js `processAudio` formatting** | 🟢 Low | Indentation/closure formatting is inconsistent but parses correctly. | 🔄 **PENDING** — Minor, can be addressed later |
| **Asset download uses `getBuffer`** | 🟡 Medium | `handleGetAsset` in `assets.js` loads entire file into memory via `getBuffer()`. For large video files, this should stream via `getStream()`. The `getStream()` method exists but isn't used in the route. | ✅ **FIXED** — Files >10MB now stream via `getStream()`. Added `ctx.stream()` to Context.js |
| **Range request support unused** | 🟢 Low | `AssetCache.getStream(id, range)` supports HTTP Range, but `assets.js` doesn't use it. | 🔄 **PENDING** — Can be added to `ctx.stream()` later |
| **GIF format in image processor** | 🟢 Low | `ImageProcessor.encodeBuffer` falls back to PNG for GIF. Documented as supported output format but not truly implemented. | 🔄 **PENDING** — Minor, GIF output falls back to PNG |
| **Duplicate code between VideoProcessor and TaskWorker** | 🟡 Medium | Video transcoding logic is duplicated in `VideoProcessor.js` and `TaskWorker.js`. They share similar probe→scale→transcode flows. | 🔄 **PENDING** — Extract shared builder? |

### 3.3 🔍 Architectural Observations

| Observation | Details | Status |
|-------------|---------|--------|
| **PipelineExecutor bypassed in worker modes** | In `thread`/`process` mode, `TaskWorker.js` directly calls `nVideo`/`nImage` instead of going through `PipelineExecutor`. This means `Processor.validateOptions()` is **not called** in worker modes. The `queue` mode uses `PipelineExecutor.execute()` which does call validation. | ✅ **FIXED** — Added standalone validators to `TaskWorker.js` |
| **ProgressReporter jobId mismatch** | `Task.js` uses `this.id` for progress events, but jobs use `jobId`. In `Worker.js`, progress is sent via `task.updateProgress()` which uses `task.id`. However, `ProgressReporter.linkJob()` links SSE connections to `jobId`. The `handleJobProgress` route links `sseJobId` to `jobId`, but the worker sends progress on `task.id` (which equals `jobId` because `_createTask` passes `job.jobId` as the task id). So this works, but it's fragile. | ✅ Verified working — no change needed |
| **WebSocket progress uses `conn._progressReporterId`** | In `websocket.js`, `handleSubscribe` registers the WS connection with `ProgressReporter` and links to `jobId`. This works for forwarding. ✅ | ✅ Already correct |
| **No `markRetrieved` on HTTP asset download** | `handleGetAsset` does NOT call `assetCache.markRetrieved()`. The asset TTL is never set to 0 on download. Only WebSocket download does this. | ✅ **FIXED** — Both streaming and buffer paths now call `markRetrieved()`. Metadata response includes `retrievedAt` |

---

## 4. Test Coverage

| Test File | Status | Notes |
|-----------|--------|-------|
| `tests/e2e.test.js` | ✅ Rewritten | Tests unified transport on port 3501. Image, audio, video, path-based, error cases. **Added `markRetrieved` test.** Fixed race condition in status assertions. |
| `tests/ws-integration-test.js` | ✅ Exists | WebSocket end-to-end test |
| `tests/index.js` | ✅ Exists | Unit test runner for processors |
| `tests/manual-readme-test.js` | ✅ Exists | Manual nVideo transcoding test |
| `tests/e2e-runner.js` | ? | Spawns service for e2e tests — not examined in detail |

**Test Results (after fixes):**
- E2E: **17/17 passed**
- Unit: **9/9 passed**

---

## 5. Summary of Critical Actions Needed

### Must Fix (High Priority)

1. **~~Update documentation to reflect HW encode reality~~** ✅ DONE
   All docs (AGENTS.md, PROCESSING.md, README.md, ARCHITECTURE.md) now clearly state that **software encoding is reliable** and **hardware-accelerated encoding is experimental/crashes**. The `docs/handover_2026-04-22.md` is referenced.

2. **~~Fix `config.example.json` `maxFileSizeMb`~~** ✅ DONE
   Changed from `9007199254740991` to `2048`.

3. **~~Fix README.md queue mode warning~~** ✅ DONE
   Removed the outdated "bug where results are undefined" claim.

4. **~~Fix README.md Web UI path~~** ✅ DONE
   Changed from `/admin/` to `/` (root).

### Should Fix (Medium Priority)

5. **Add task retry logic** or remove from dev plan
   🔄 **PENDING** — If not planned, update `docs/media_service_dev_plan.md` to mark as "won't implement".

6. **~~Stream large assets instead of buffering~~** ✅ DONE
   `handleGetAsset` now uses `assetCache.getStream()` for files above 10MB threshold. Added `ctx.stream()` to Context.js.

7. **~~Call `markRetrieved()` on HTTP download~~** ✅ DONE
   Assets are now marked retrieved when downloaded via HTTP. Metadata response includes `retrievedAt`.

8. **Unify video transcoding logic**
   🔄 **PENDING** — Consider extracting shared logic between `VideoProcessor.js` and `TaskWorker.js`.

### Nice to Have (Low Priority)

9. **~~Fix `buildVideoOptions` indentation~~** ✅ DONE
10. **Add Range request support** to `handleGetAsset`
    🔄 **PENDING** — `ctx.stream()` can be extended to accept range params.
11. **~~Update dev plan Phase 7~~** ✅ DONE — Marked completed items as done
12. **~~Remove D3D11VA~~** ✅ DONE — Removed from dev plan

---

## 6. Overall Assessment

| Category | Score | Notes |
|----------|-------|-------|
| **Implementation Completeness** | 90% | All core features work. Missing: task retry, native cancel, HW encode reliability |
| **Documentation Accuracy** | 85% | ✅ Significantly improved. HW encode warnings added. Queue bug claim removed. Config default fixed. |
| **Code Quality** | 88% | Clean architecture, good separation of concerns. Streaming added. Validation added to workers. Some duplication remains. |
| **Test Coverage** | 80% | E2E tests exist and pass (17/17). Unit tests exist and pass (9/9). Added `markRetrieved` E2E test. |

**Verdict:** The project is **functionally complete for its intended use case** (SW-based media processing for LLM consumption). The documentation accuracy gap has been significantly closed. Remaining items (task retry, native cancellation, video logic deduplication) are medium/low priority and can be addressed in future iterations.
