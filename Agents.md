# nMedia — LLM Briefing

**Purpose**: one HTTP service for media work — images, audio, video, HEIC, SVG —
with durable jobs, a cached asset store and honest capability reporting.

**Lineage**: this repo held a Node implementation (nImage/nVideo N-API modules,
a custom router, a task queue). The Rust rewrite replaced it in place on
2026-11-12; the old tree is in git history, not on disk. The HTTP contract was
preserved deliberately — consumers were not changed.

---

## Non-negotiables

1. **The contract is the product.** Endpoints, `{success, data}` envelopes, option
   keys and the *legacy* routes are what other services compile against. Changing
   a response shape is a breaking change even if nothing "fails".
2. **Engines are driven, never reimplemented.** ffmpeg for audio/video/HEIC,
   Chromium or resvg for SVG, `image`+`fast_image_resize` for rasters. Verify with
   the tool, not from memory.
3. **Refuse by name, never ignore.** An option this build cannot honour, a config
   key it does not know, a path outside the allowlist: say so. Silent degradation
   is the one defect a consumer cannot detect.
4. **Readiness is probed, not asserted.** `/health` reports what the binary in
   front of it can do (`ffmpeg` present? which version? Chromium?).
5. **Nothing grows without bound.** Assets, uploads and terminal job records age
   out on a timer; admission is bounded and refuses with 429.

---

## Layout

```
src/
  main.rs            config (config.json + env) → state → router
  logging.rs         JSONL main log + session file, per infra_nlogger.md
  server state       AppState: config, AssetCache, JobStore, Engines
  assets.rs          <cache>/assets/<id>.<ext> + <id>.json sidecar
  jobs.rs            per-job JSON, broadcast SSE, admission, cancellation
  process.rs         /v1/upload, /v1/process, executor (image/audio/video)
  legacy.rs          /v1/process/{image,image/crop,audio,video}, tasks, probes
  image_processor.rs option set, decode/resize/encode, SVG engine dispatch
  ffmpeg.rs          child process: transcode, still-image decode (HEIC), probes
  chromium.rs        headless screenshot for exact SVG rendering
  engines.rs         startup probe: version, hwaccels, encoders, filters
  capabilities.rs    the discovery contract
  retention.rs       sweeper: assets by TTL then size, uploads, jobs
  health.rs, util.rs
tests/               PowerShell harness + contract fixtures
```

## The two contracts (this is the trap)

**Modern** `/v1/process` returns a `jobId`; the caller polls or subscribes, and
assets are fetched by id. Wrapped in `{ success, data }`.

**Legacy** `/v1/process/image` and `/v1/process/image/crop` are *inline* and
**flat**: `{ success, base64, format, width, height }` with no wrapper — three
consumers read top-level keys and would get `undefined` from a wrapped reply
while still seeing HTTP 200. `format` is a bare subtype (`jpeg`, not `image/jpeg`)
because a consumer builds `data:image/${format}`. Base64 in ⇒ base64 out;
`response_type` is only an override. Crop takes a **normalised**
`{left,top,right,bottom}` and answers `crops: [ … ]` — a single-element array on
purpose.

## Where the sharp edges are

- **Deterministic behaviour over convenience:** a failed `output_path` publication
  fails the job but keeps the asset id, so a retry never re-runs the engine.
- **Cancellation kills the child.** `queued → processing` is a compare-and-swap;
  terminal states are final. A cancelled ffmpeg is killed and reaped.
- **Transparency:** tiny-skia hands back *premultiplied* RGBA — un-premultiply
  before encoding or translucent pixels darken. Formats that cannot carry alpha
  (JPEG, BMP) **refuse** unless `background` or `transparent:false` is given.
- **SVG has two engines.** Chromium is exact (CSS variables, media queries, font
  weights); resvg is in-process and approximate — its limits are published in
  `/v1/capabilities`. Default is Chromium when installed.
- **HEIC** has no Rust decoder here: ffmpeg decodes it to PPM (measured 4.5×
  faster than the alternatives with identical detail), and it colour-manages
  correctly where Windows WIC does not.
- **Logging** follows the ecosystem convention; a file handle held open leaves the
  directory entry at size 0 on Windows, so files are opened per line.

## Running

```bash
cargo build --release
target/release/nmedia-server.exe          # reads ./config.json, env overrides
```

Deployed on Badkid as the nPM service `mediaservice` (port 3500), config at
`config.json` beside the binary; logs in `./logs`.
