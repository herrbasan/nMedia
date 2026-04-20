# Media Service - Issue Post-Mortem & Handover

## C++ Segfault / Access Violation (`Exit 3221225477`)
**Symptom:** Transcoding with NVENC codecs (`av1_nvenc`, `h264_nvenc`) immediately caused a silent process crash (`0xC0000005` Segfault) when started from the UI/CLI preset.

**The "Lost Plot" (What we tried that failed disastrously):**
- We incorrectly assumed the native FFmpeg C++ binding (`modules/nVideo/src/processor.cpp`) had unhandled memory leaks, missing `av_packet_unref` calls, or bad pointer cleanup during hardware frame transfers.
- We used aggressive JS/Regex scripts (`fix_processor.js`) to mutate `processor.cpp` inline, trying to blindly patch memory allocations and packet handling.
- This deeply corrupted the FFmpeg frame lifecycle and destroyed all working transcode paths, masking the true error entirely.

**The Recovery:**
- We finally halted C++ debugging after realizing native workflows were regressing.
- We used Git to roll `modules/nVideo` strictly back to the latest known-stable commit (`06982e1` - right before AVDictionary options were added).
- Purged the `node-gyp` cache completely and rebuilt the clean native binary (`npm run clean && npm run build`).

**The Actual Root Cause & Real Fix:**
- In `src/tasks/TaskWorker.js`, there was a hardcoded block auto-injecting `hwaccel: 'cuda'` into the task payload anytime a codec string included `nvenc`.
- Forcing CUDA hardware frame decoding and `av_hwframe_transfer_data` in a generic pipeline not fully configured for end-to-end hwaccels caused the C++ segfault trying to bind NVENC frames to RAM.
- **Fix:** Removed the `hwaccel = 'cuda'` auto-injection block completely from `TaskWorker.js`. Selecting NVENC now reliably delegates to the GPU just for **encoding** via standard OS surface memory mapping, keeping default NVENC acceleration without breaking the decoder bindings.

## Next Steps for the User
1. Delete any leftover node test scripts floating around (`temp.js`, `temp.txt`, `_Archive/ffprobe_test.js`, and `modules/nVideo/fix_processor.js`).
2. Commit the `src/tasks/TaskWorker.js` and `src/tasks/Worker.js` modifications alongside `AssetCache.js` (this locks in the IPC payload fix and hardware acceleration bypass).
3. Keep the `modules/nVideo` submodule pinned or committed to the stable `06982e1` commit going forward so `avcodec_open2` dictionary pipeline bugs do not accidentally return.# Handover: CLI Video Transcode Feature

**Date:** 2026-04-20
**Status:** Partially working — needs design input on HW encoder option validation
**Branch:** `main` (uncommitted changes in working tree)

---

## What We Built

A CLI tab in the Task Builder UI that lets users paste FFmpeg-style command lines. The parser converts CLI flags into structured options that flow through the backend and into nVideo's native C++ transcoder.

**Example CLI input:**
```bash
ffmpeg -i input.mp4 -c:v av1_nvenc -preset p7 -pix_fmt p010le -rc vbr -cq 23 -tune hq -spatial_aq 1 -temporal_aq 1 -multipass 2 output.mp4
```

**Data flow:**
```
Frontend CLI input
    |
    v
video-tasks.js: parseCliToNVideo()  →  videoOptions / audioOptions maps
    |
    v
VideoProcessor.js / TaskWorker.js: buildVideoOptions()  →  nVideo JS API shape
    |
    v
binding.cpp: TranscodeOptions struct  →  C++
    |
    v
processor.cpp: AVDictionary  →  avcodec_open2(encoder, &dict)
```

---

## Architecture Decisions

### Three-Tier Option System

| Tier | Examples | Handling |
|------|----------|----------|
| **Structural** | `codec`, `width`, `height` | Set directly on `AVCodecContext` fields |
| **Well-known** | `preset`, `crf`/`cq`, `bitrate` | Mapped codec-specifically in `buildVideoOptions()` helpers |
| **Arbitrary** | `rc`, `tune`, `spatial_aq`, `multipass` | Passed through `AVDictionary` to `avcodec_open2()` |

### Codec-Specific Mapping (Single Source of Truth)

Consolidated in `buildVideoOptions()` in both `VideoProcessor.js` and `TaskWorker.js`:
- `crf` → `cq` for NVENC codecs
- Preset names mapped: `medium` → `p4`, `slow` → `p6`, etc. for NVENC
- All other options pass through untouched

### Native Layer: AVDictionary Approach

The C++ layer uses FFmpeg's standard mechanism:

```cpp
AVDictionary* encOpts = nullptr;
av_dict_set(&encOpts, "rc", "vbr", 0);
av_dict_set(&encOpts, "cq", "23", 0);
// ... more options
avcodec_open2(videoEncCtx, videoEnc, &encOpts);
```

This is the same mechanism FFmpeg CLI uses internally. Options in the dict are applied to both `AVCodecContext` public fields and the encoder's `priv_data` (NVENC-specific options like `spatial_aq`).

---

## What's Working

- `h264_nvenc` with `rc=vbr`, `tune=hq`, `spatial_aq=1` — tested successfully
- CLI parser correctly extracts flags into `videoOptions` / `audioOptions` maps
- Backend consolidation removes duplicate inline mapping code
- Options priority: explicit `videoOptions` map overrides well-known defaults

---

## The Core Problem

### `av1_nvenc` fails with "Invalid argument"

When running `av1_nvenc` with a full NVENC Quality preset, `avcodec_open2` returns `EINVAL`. The problem: **we don't know which specific option caused the failure**.

FFmpeg's `avcodec_open2` is a black box. It returns a single error code for the entire option set. Unlike the CLI which can report "Option X not found," the C API gives us nothing actionable.

### Attempted Solution: Per-Option Diagnostic Testing

We added diagnostic code that, when `avcodec_open2` fails:

1. Tests if the codec opens with **no options at all** (proves the codec itself is valid)
2. If step 1 succeeds, tests **each option individually** in a throwaway `AVCodecContext`
3. Reports the exact option name + value that caused the failure

**Implementation:** `testVideoEncoderOption()` and `testAudioEncoderOption()` helpers in `processor.cpp`.

### Why This Crashed the Service (Twice)

The diagnostic test allocates a bare `AVCodecContext` and calls `avcodec_open2` with a single option. Two things went wrong:

**Crash #1:** The test used `AV_PIX_FMT_CUDA` (copied from the real encoder context). Opening NVENC with a CUDA pixel format but **no `hw_device_ctx` or `hw_frames_ctx`** triggers an access violation in the CUDA driver. The process dies instantly with no error message — the host Node.js server goes down, SSE connections reset.

**Fix #1:** Changed the test helper to use `AV_PIX_FMT_YUV420P` (safe software format) for option validation. This tests whether the option string is accepted by the codec's option parser without requiring a full HW pipeline.

**Crash #2:** The *bare context test* (step 1 above) also copied `pix_fmt` from the real encoder context. Same problem — `CUDA` pixel format with no HW context.

**Fix #2:** Changed the bare context test to also use `AV_PIX_FMT_YUV420P`.

### Why `av1_nvenc` Still Fails (The Real Issue)

After fixing the crashes, the diagnostic now correctly reports:

```
Invalid combination of video options for codec 'av1_nvenc'.
Each option is valid individually, but they cannot be used together.
```

This means: every single option (`preset=p7`, `rc=vbr`, `cq=23`, `tune=hq`, etc.) is accepted by `av1_nvenc` when tested **alone**. But some combination of them is invalid.

**The diagnostic can't test combinations.** With N options, there are 2^N possible subsets. Testing all combinations is exponential and impractical.

### The `pix_fmt` / HW Format Complication

There's a second, related issue with `pix_fmt` for HW encoders:

For **software encoding**, `pix_fmt` is simple:
```cpp
videoEncCtx->pix_fmt = AV_PIX_FMT_YUV420P;  // or whatever user specified
```

For **HW encoding** (NVENC), `pix_fmt` is actually `CUDA` (the HW surface format). The CPU-side format goes into the HW frames context:
```cpp
AVHWFramesContext* framesCtx = ...;
framesCtx->format = AV_PIX_FMT_CUDA;       // GPU surface format
framesCtx->sw_format = AV_PIX_FMT_NV12;    // CPU-side format before upload
```

When the user specifies `-pix_fmt p010le`, that should affect `sw_format` (the CPU-side format), not `pix_fmt` (which must remain `CUDA`). But our current code doesn't handle this — it sets `pix_fmt` on the `AVCodecContext` which gets overridden to `CUDA` by the HW path, and the `sw_format` stays hardcoded to `NV12`.

**This means 10-bit AV1 encoding (`p010le`) is not currently supported even if the options were valid.**

---

## Open Questions / Design Challenges

### 1. How to validate option combinations efficiently?

The per-option diagnostic works for identifying single bad options (e.g., `spatial_aq` not supported by `av1_nvenc`). But it can't identify invalid combinations (e.g., `rc=vbr` + `cq=23` + `multipass=2`).

**Possible approaches:**
- **Binary search on subsets:** Test half the options, then half of the failing half, etc. O(log N) tests to narrow down.
- **FFmpeg's own validation:** Could we call into FFmpeg's option parsing code directly? FFmpeg CLI must do this somewhere.
- **Codec-specific knowledge base:** Maintain a small table of known incompatible options per codec (e.g., `av1_nvenc` doesn't support `spatial_aq`). This is the "fiction" we wanted to avoid but may be necessary.
- **Simpler approach:** For NVENC, validate that `cq` is only used with `rc=vbr`, `rc=constqp`, or `rc=cbr`. Different RC modes have different valid companion options.

### 2. How should `pix_fmt` work for HW encoders?

The current code has a hardcoded `sw_format = NV12` for all HW encoders. This works for 8-bit but not 10-bit.

**Questions:**
- Should `pix_fmt` in the options map set `sw_format` for HW encoders?
- How do we ensure the decoder output matches `sw_format`? If the decoder outputs NV12 and `sw_format` is P010, the CUDA upload will fail.
- Should we add a format conversion filter automatically? (`format=pix_fmts=p010le`)

### 3. Service crash on native errors

When nVideo crashes (CUDA access violation, etc.), the entire Node.js process dies. There is no stack trace, no log entry — the service just disappears.

**Questions:**
- Should we add a separate watchdog process?
- Can we catch native crashes in worker threads? (Unlikely — access violations aren't catchable.)
- Should diagnostic testing run in a separate process entirely?

### 4. Should we even do diagnostic testing?

An alternative to the complex diagnostic code: **let FFmpeg fail and report the raw error.**

Pros:
- Simpler code, fewer crash vectors
- FFmpeg's error message may improve in future versions
- No risk of diagnostic code causing crashes

Cons:
- User gets "Invalid argument" with no actionable information
- Harder to debug which option caused the failure

---

## Files Changed

### Frontend
- `public/taskbuilder/js/video-tasks.js` — CLI parser, option handling, removed try/catch for debuggability
- `public/taskbuilder/pages/video-tasks.html` — CLI tab UI

### Backend
- `src/processors/video/VideoProcessor.js` — `buildVideoOptions()` / `buildAudioOptions()` helpers, consolidated codec-specific mapping
- `src/tasks/TaskWorker.js` — Same helpers, used in worker thread transcode path

### Native (nVideo submodule)
- `modules/nVideo/src/processor.cpp` — AVDictionary for video/audio encoder options, diagnostic helpers, audio option dictionary support
- `modules/nVideo/src/processor.h` — `TranscodeOptions` struct already had `options` map fields (no change needed)

### Documentation
- `documentation/README.md` — Updated API docs
- `documentation/PROCESSING.md` — Updated processing workflows

---

## Reproduction Steps

1. Start Media Service
2. Open Task Builder → Video Tasks → CLI tab
3. Paste:
   ```
   ffmpeg -i input.mp4 -c:v av1_nvenc -preset p7 -pix_fmt p010le -rc vbr -cq 23 -tune hq -spatial_aq 1 -temporal_aq 1 -multipass 2 output.mp4
   ```
4. Select a test video file
5. Click Run Task
6. Observe: job starts, then fails with "Invalid combination of video options for codec 'av1_nvenc'"

To see the service crash (before diagnostic fixes):
1. Revert `processor.cpp` to use `pix_fmt` from encoder context in diagnostic tests
2. Rebuild nVideo
3. Run the same test
4. Observe: SSE connection resets, service process disappears

---

## Next Steps (Proposed)

1. **Short term:** Remove the diagnostic code entirely and let FFmpeg fail naturally. The diagnostic is too risky (multiple crash vectors) and doesn't solve the combination problem anyway.

2. **Medium term:** Investigate FFmpeg's own option validation. The CLI must have code that checks option combinations. Can we call into that, or at least read the same tables?

3. **Long term:** For rock-solid CLI compatibility, consider spawning the actual FFmpeg CLI as a subprocess for the transcode path. This sacrifices some performance and progress granularity but guarantees 100% CLI compatibility. nVideo would still be used for probe/thumbnail/waveform where performance matters.

---

## Key Contacts / Context

- **nVideo submodule:** `modules/nVideo/` — our own project, can be modified
- **AGENTS.md:** `modules/nVideo/AGENTS.md` — nVideo development guide, contains architecture notes
- **Test assets:** `tests/assets/videos/` — MP4, MOV files for testing
- **Build:** `cd modules/nVideo && npm run build` (requires service stopped for dist copy)
