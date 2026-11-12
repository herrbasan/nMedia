//! Legacy surfaces kept for compatibility.
//!
//! The Node service carried three generations of API at once: synchronous
//! `/v1/process/{image,audio,video}`, the `/v1/tasks*` system, and a `/v1/ws`
//! socket. The job API is the one worth keeping. The synchronous routes are thin
//! wrappers over the same processors (same code, no second implementation), and
//! `/v1/tasks*` is an adapter over the job store so a caller that only knows tasks
//! keeps working. `/v1/ws` is refused by name â€” SSE carries progress, and a
//! half-built socket would be worse than an honest 501.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::assets;
use crate::ffmpeg;
use crate::image_processor::{self, ImageOptions};
use crate::process::ProcessRequest;
use crate::AppState;

fn fail(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(serde_json::json!({ "success": false, "error": message.into() })),
    )
        .into_response()
}

// â”€â”€â”€ synchronous legacy processing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// The legacy image routes are a DIFFERENT contract from /v1/process: consumers
// (mcp_server's image, chart and vision agents) post raw base64 and read the
// image back inline. What they actually do, verbatim from their code:
//
//   POST /v1/process/image      { base64, format, max_dimension?, quality?, response_type? }
//     -> flat { success, base64, format, width, height }   (no {data:} wrapper)
//   POST /v1/process/image/crop { base64, crop:{left,top,right,bottom}, quality?, format? }
//     -> { success, crops: [ { base64, format, width, height } ] }
//
// Rules that follow from that code and are easy to get wrong:
// - The reply is FLAT. The crop consumer tolerates `data.crops`, the other two
//   read top-level keys only, so a wrapper silently yields `base64: undefined`.
// - `format` is the mime source of truth, as a bare subtype (`jpeg`, not `jpg`,
//   not `image/jpeg`): the vision agent builds `data:image/${format}`.
// - Base64 in -> base64 out. `response_type` is an override, not the switch.
// - Never a 200 with a null body: these consumers do not check `success`.

/// Decode the request body into processor options, dropping the transport keys so
/// unknown *option* names still fail loudly.
fn options_from_body(body: &Value) -> Result<ImageOptions, String> {
    let mut map = match body.as_object() {
        Some(map) => map.clone(),
        None => return Err("body must be a JSON object".to_string()),
    };
    // `crop` is geometry, not a processor option: the Crop struct is pixel-based,
    // while callers send normalised corners. Handlers resolve it after decode.
    for transport in ["base64", "input_path", "file_id", "response_type", "crop"] {
        map.remove(transport);
    }
    serde_json::from_value(Value::Object(map))
        .map_err(|e| format!("unknown image option(s): {e}"))
}

fn format_token(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "jpeg",
        "png" => "png",
        "webp" => "webp",
        "gif" => "gif",
        "bmp" => "bmp",
        "tiff" => "tiff",
        "ico" => "ico",
        "tga" => "tga",
        "avif" => "avif",
        _ => "png",
    }
}

fn inline_reply(processed: &image_processor::Processed) -> Response {
    // FLAT on purpose: the consumers read top-level `base64`/`width`/`height`.
    // A `{data:{…}}` wrapper would hand them `undefined` while still looking
    // like a 200.
    Json(serde_json::json!({
        "success": true,
        "base64": crate::util::base64_encode(&processed.bytes),
        "format": format_token(processed.ext),
        "width": processed.width,
        "height": processed.height,
        "mime": processed.mime,
    }))
    .into_response()
}

pub async fn image(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> Response {
    let mut opts = match options_from_body(&body) {
        Ok(opts) => opts,
        Err(e) => return fail(StatusCode::BAD_REQUEST, e),
    };
    let wants_inline = body.get("base64").and_then(|v| v.as_str()).is_some()
        || body.get("response_type").and_then(|v| v.as_str()) == Some("base64");

    let source = match read_source(&state, &body).await {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };

    // The same endpoint also accepts a crop rectangle; resolve it against the
    // decoded size rather than making callers do the arithmetic.
    let source = if let Some(crop) = body.get("crop") {
        match image::load_from_memory(&source) {
            Ok(probe) => match crop_rect(crop, probe.width(), probe.height()) {
                Ok(rect) => {
                    opts.crop = Some(rect);
                    source
                }
                Err(e) => return fail(StatusCode::BAD_REQUEST, e),
            },
            Err(e) => return fail(StatusCode::UNPROCESSABLE_ENTITY, format!("cannot decode image: {e}")),
        }
    } else {
        source
    };

    let work = state.config.cache_dir.join("work");
    match tokio::task::spawn_blocking(move || image_processor::process(&source, &opts, &work)).await {
        Ok(Ok(processed)) => {
            if wants_inline {
                inline_reply(&processed)
            } else {
                // A path/fileId caller that did not ask for inline data gets an
                // asset, which is what the modern routes promise.
                match store_processed(&state, processed) {
                    Ok(saved) => crate::ok(saved).into_response(),
                    Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, e),
                }
            }
        }
        Ok(Err(e)) => fail(StatusCode::UNPROCESSABLE_ENTITY, e),
        Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, format!("image worker panicked: {e}")),
    }
}

/// Crop: the consumer sends a normalised rectangle against the *displayed* image
/// and reads `crops[0]`. One rectangle in, one element out — the array is a shape
/// to preserve, not a batch API.
pub async fn image_crop(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> Response {
    let mut opts = match options_from_body(&body) {
        Ok(opts) => opts,
        Err(e) => return fail(StatusCode::BAD_REQUEST, e),
    };
    let source = match read_source(&state, &body).await {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };

    // Pixel geometry needs the real dimensions, so decode once up front.
    let probe = match image::load_from_memory(&source) {
        Ok(img) => img,
        Err(e) => return fail(StatusCode::UNPROCESSABLE_ENTITY, format!("cannot decode image: {e}")),
    };
    let (width, height) = (probe.width(), probe.height());
    let Some(crop) = body.get("crop") else {
        return fail(StatusCode::BAD_REQUEST, "crop is required");
    };
    let rect = match crop_rect(crop, width, height) {
        Ok(rect) => rect,
        Err(e) => return fail(StatusCode::BAD_REQUEST, e),
    };
    drop(probe);
    opts.crop = Some(rect);

    let work = state.config.cache_dir.join("work");
    match tokio::task::spawn_blocking(move || image_processor::process(&source, &opts, &work)).await {
        Ok(Ok(processed)) => Json(serde_json::json!({
            "success": true,
            "crops": [{
                "base64": crate::util::base64_encode(&processed.bytes),
                "format": format_token(processed.ext),
                "width": processed.width,
                "height": processed.height,
                "mime": processed.mime,
            }],
        }))
        .into_response(),
        Ok(Err(e)) => fail(StatusCode::UNPROCESSABLE_ENTITY, e),
        Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, format!("image worker panicked: {e}")),
    }
}

/// Normalised `{left,top,right,bottom}` (0..1) or pixel `{x,y,width,height}`.
fn crop_rect(crop: &Value, width: u32, height: u32) -> Result<crate::image_processor::Crop, String> {
    let number = |key: &str| crop.get(key).and_then(|v| v.as_f64());
    if let (Some(left), Some(top), Some(right), Some(bottom)) =
        (number("left"), number("top"), number("right"), number("bottom"))
    {
        let clamp = |v: f64| v.clamp(0.0, 1.0);
        let (left, top, right, bottom) = (clamp(left), clamp(top), clamp(right), clamp(bottom));
        if right <= left || bottom <= top {
            return Err(format!(
                "crop {left:.4},{top:.4}..{right:.4},{bottom:.4} has no area"
            ));
        }
        let x = (left * width as f64).round() as u32;
        let y = (top * height as f64).round() as u32;
        let w = ((right - left) * width as f64).round().max(1.0) as u32;
        let h = ((bottom - top) * height as f64).round().max(1.0) as u32;
        return Ok(crate::image_processor::Crop {
            x: x.min(width.saturating_sub(1)),
            y: y.min(height.saturating_sub(1)),
            width: w.min(width.saturating_sub(x)),
            height: h.min(height.saturating_sub(y)),
        });
    }
    let x = number("x").unwrap_or(0.0).max(0.0) as u32;
    let y = number("y").unwrap_or(0.0).max(0.0) as u32;
    let w = number("width").or_else(|| number("w")).ok_or_else(|| {
        "crop needs either left/top/right/bottom (0..1) or x/y/width/height (pixels)".to_string()
    })? as u32;
    let h = number("height").or_else(|| number("h")).ok_or_else(|| {
        "crop needs either left/top/right/bottom (0..1) or x/y/width/height (pixels)".to_string()
    })? as u32;
    if w == 0 || h == 0 {
        return Err("crop width/height must be greater than zero".to_string());
    }
    Ok(crate::image_processor::Crop { x, y, width: w, height: h })
}

/// base64 (raw or data URI) or a path/fileId, in that order of preference.
async fn read_source(state: &Arc<AppState>, body: &Value) -> Result<Vec<u8>, Response> {
    if let Some(encoded) = body.get("base64").and_then(|v| v.as_str()) {
        let payload = match encoded.find("base64,") {
            Some(index) => &encoded[index + 7..],
            None => encoded,
        };
        return crate::util::base64_decode(payload)
            .ok_or_else(|| fail(StatusCode::BAD_REQUEST, "base64 payload is not valid base64"));
    }
    let file_id = body.get("file_id").and_then(|v| v.as_str()).map(str::to_string);
    let input_path = body.get("input_path").and_then(|v| v.as_str()).map(str::to_string);
    let Some(path) = resolve_any(state, file_id, input_path) else {
        return Err(fail(
            StatusCode::BAD_REQUEST,
            "provide base64, input_path or file_id",
        ));
    };
    match state.config.allowed_input.check_existing(&path, "file") {
        Ok(path) => tokio::fs::read(&path)
            .await
            .map_err(|e| fail(StatusCode::BAD_REQUEST, format!("cannot read {}: {e}", path.display()))),
        Err(e) => Err(fail(StatusCode::FORBIDDEN, e)),
    }
}

fn store_processed(
    state: &AppState,
    processed: image_processor::Processed,
) -> Result<crate::assets::AssetMeta, String> {
    let meta = assets::new_meta(
        &format!("output.{}", processed.ext),
        processed.mime,
        Some(processed.width),
        Some(processed.height),
    );
    state
        .assets
        .put(meta, &processed.bytes)
        .map_err(|e| format!("cannot store asset: {e}"))
}

pub async fn audio(State(state): State<Arc<AppState>>, Json(request): Json<ProcessRequest>) -> Response {
    legacy_av(state, request, "audio").await
}

pub async fn video(State(state): State<Arc<AppState>>, Json(request): Json<ProcessRequest>) -> Response {
    legacy_av(state, request, "video").await
}

async fn legacy_av(state: Arc<AppState>, request: ProcessRequest, processor: &str) -> Response {
    // Synchronous legacy routes reuse the job machinery and wait for the ending,
    // so there is exactly one execution path.
    let body = crate::process::process(State(state.clone()), Json(ProcessRequest { processor: processor.into(), ..request })).await;
    let status = body.status();
    let bytes = match axum::body::to_bytes(body.into_body(), usize::MAX).await {
        Ok(b) => b,
        Err(e) => return fail(StatusCode::INTERNAL_SERVER_ERROR, format!("cannot read job response: {e}")),
    };
    if status != StatusCode::OK {
        return (status, bytes).into_response();
    }
    let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let job_id = parsed
        .get("data")
        .and_then(|d| d.get("jobId"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let Some(job_id) = job_id else {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "job was admitted but no id came back");
    };

    // Poll the record: the record is the authority, not the event stream.
    for _ in 0..3600 {
        if let Some(job) = state.jobs.get(&job_id) {
            if job.terminal() {
                return match job.status.as_str() {
                    "completed" => crate::ok(job).into_response(),
                    _ => fail(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        job.error.unwrap_or_else(|| format!("job {}", job.status)),
                    ),
                };
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    fail(StatusCode::GATEWAY_TIMEOUT, format!("job {job_id} did not finish within 15 minutes"))
}

fn resolve_input(state: &AppState, file_id: Option<String>, input_path: Option<String>) -> Option<PathBuf> {
    resolve_any(state, file_id, input_path)
}

// â”€â”€â”€ probes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[derive(Debug, Deserialize)]
pub struct ProbeBody {
    #[serde(default)]
    pub input_path: Option<String>,
    #[serde(default)]
    pub file_id: Option<String>,
}

pub async fn audio_probe(State(state): State<Arc<AppState>>, Json(body): Json<ProbeBody>) -> Response {
    probe(state, body).await
}

pub async fn video_probe(State(state): State<Arc<AppState>>, Json(body): Json<ProbeBody>) -> Response {
    probe(state, body).await
}

async fn probe(state: Arc<AppState>, body: ProbeBody) -> Response {
    let Some(path) = resolve_any(&state, body.file_id, body.input_path) else {
        return fail(StatusCode::BAD_REQUEST, "either input_path or fileId is required");
    };
    match ffmpeg::probe(&path).await {
        Ok(value) => crate::ok(value).into_response(),
        Err(e) => fail(StatusCode::UNPROCESSABLE_ENTITY, e),
    }
}

fn resolve_any(state: &AppState, file_id: Option<String>, input_path: Option<String>) -> Option<PathBuf> {
    if let Some(file_id) = file_id {
        let dir = state.config.uploads_dir.join(file_id);
        return std::fs::read_dir(dir).ok()?.next().and_then(|e| e.ok()).map(|e| e.path());
    }
    input_path.map(PathBuf::from)
}

// â”€â”€â”€ utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[derive(Debug, Deserialize)]
pub struct ThumbQuery {
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
}

/// Best effort: images get a real thumbnail; anything else is refused with the
/// reason instead of returning a broken image.
pub async fn thumbnail(
    State(state): State<Arc<AppState>>,
    AxumPath(relative): AxumPath<String>,
    Query(query): Query<ThumbQuery>,
) -> Response {
    let Some(path) = resolve_any(&state, None, Some(relative)) else {
        return fail(StatusCode::BAD_REQUEST, "a file path is required");
    };
    // Reading an arbitrary path through a public route is a file-disclosure bug,
    // so the same allowlist the processors use applies here.
    let path = match state.config.allowed_input.check_existing(&path, "file") {
        Ok(p) => p,
        Err(e) => return fail(StatusCode::FORBIDDEN, e),
    };
    if !path.is_file() {
        return fail(StatusCode::NOT_FOUND, format!("no such file: {}", path.display()));
    }
    let width = query.width.unwrap_or(320).clamp(16, 2048);
    let format = query.format.unwrap_or_else(|| "png".into());
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) => return fail(StatusCode::INTERNAL_SERVER_ERROR, format!("cannot read: {e}")),
    };
    let opts = ImageOptions {
        max_dimension: Some(width),
        format: Some(format),
        ..Default::default()
    };
    let work = state.config.cache_dir.join("work");
    match tokio::task::spawn_blocking(move || image_processor::process(&bytes, &opts, &work)).await {
        Ok(Ok(p)) => (
            [(axum::http::header::CONTENT_TYPE, p.mime)],
            p.bytes,
        )
            .into_response(),
        Ok(Err(e)) => fail(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("thumbnail needs an image: {e}"),
        ),
        Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, format!("image worker panicked: {e}")),
    }
}

/// Static metadata: image dimensions when it decodes, ffprobe's JSON otherwise.
pub async fn info(State(state): State<Arc<AppState>>, AxumPath(relative): AxumPath<String>) -> Response {
    let path = PathBuf::from(&relative);
    let path = match state.config.allowed_input.check_existing(&path, "file") {
        Ok(p) => p,
        Err(e) => return fail(StatusCode::FORBIDDEN, e),
    };
    if !path.is_file() {
        return fail(StatusCode::NOT_FOUND, format!("no such file: {}", path.display()));
    }

    // Sniff the header before reading a 500 MB video into memory to prove it is
    // not an image.
    let head = match std::fs::File::open(&path) {
        Ok(mut file) => {
            use std::io::Read;
            let mut buf = vec![0u8; 64];
            match file.read(&mut buf) {
                Ok(n) => buf.truncate(n),
                Err(e) => return fail(StatusCode::INTERNAL_SERVER_ERROR, format!("cannot read: {e}")),
            }
            buf
        }
        Err(e) => return fail(StatusCode::INTERNAL_SERVER_ERROR, format!("cannot read: {e}")),
    };

    if let Ok(format) = image::guess_format(&head) {
        let bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) => return fail(StatusCode::INTERNAL_SERVER_ERROR, format!("cannot read: {e}")),
        };
        let decoded = tokio::task::spawn_blocking(move || {
            image::load_from_memory(&bytes).map(|i| (i.width(), i.height()))
        })
        .await;
        if let Ok(Ok((width, height))) = decoded {
            return crate::ok(serde_json::json!({
                "kind": "image",
                "format": format!("{format:?}").to_lowercase(),
                "width": width,
                "height": height,
                "size": std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
                "path": path.to_string_lossy(),
            }))
            .into_response();
        }
    }
    match ffmpeg::probe(&path).await {
        Ok(value) => crate::ok(value).into_response(),
        Err(e) => fail(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("not an image and ffprobe could not read it: {e}"),
        ),
    }
}

// â”€â”€â”€ /v1/tasks adapter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub async fn create_task(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProcessRequest>,
) -> Response {
    let response = crate::process::process(State(state), Json(request)).await;
    let status = response.status();
    let bytes = match axum::body::to_bytes(response.into_body(), usize::MAX).await {
        Ok(b) => b,
        Err(e) => return fail(StatusCode::INTERNAL_SERVER_ERROR, format!("cannot read response: {e}")),
    };
    if status != StatusCode::OK {
        return (status, bytes).into_response();
    }
    let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let job_id = parsed
        .get("data")
        .and_then(|d| d.get("jobId"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    crate::ok(serde_json::json!({
        "taskId": job_id,
        "jobId": job_id,
        "status": "queued",
        "note": "task ids and job ids are the same identity in this service",
    }))
    .into_response()
}

pub async fn list_tasks(State(state): State<Arc<AppState>>) -> Response {
    let jobs = state.jobs.list(false, 200);
    crate::ok(serde_json::json!({ "tasks": jobs, "count": jobs.len() })).into_response()
}

pub async fn task_stats(State(state): State<Arc<AppState>>) -> Response {
    let jobs = state.jobs.list(false, 500);
    let count = |name: &str| jobs.iter().filter(|j| j.status == name).count();
    crate::ok(serde_json::json!({
        "total": jobs.len(),
        "queued": count("queued"),
        "processing": count("processing"),
        "completed": count("completed"),
        "failed": count("failed"),
        "cancelled": count("cancelled"),
        "active": state.jobs.active_count(),
        "capacity": state.jobs.capacity(),
    }))
    .into_response()
}

pub async fn get_task(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    match state.jobs.get(&id) {
        Some(job) => crate::ok(job).into_response(),
        None => fail(StatusCode::NOT_FOUND, format!("task not found: {id}")),
    }
}

pub async fn task_result(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let Some(job) = state.jobs.get(&id) else {
        return fail(StatusCode::NOT_FOUND, format!("task not found: {id}"));
    };
    match job.asset_id.as_deref() {
        Some(asset_id) => crate::ok(serde_json::json!({
            "taskId": id,
            "assetId": asset_id,
            "url": format!("/v1/assets/{asset_id}"),
            "status": job.status,
        }))
        .into_response(),
        None if job.terminal() => fail(
            StatusCode::UNPROCESSABLE_ENTITY,
            job.error.unwrap_or_else(|| format!("job {} produced no asset", job.status)),
        ),
        None => crate::ok(serde_json::json!({ "taskId": id, "status": job.status, "progress": job.progress }))
            .into_response(),
    }
}

pub async fn cancel_task(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    match state.jobs.cancel(&id) {
        Some(job) => crate::ok(job).into_response(),
        None => fail(StatusCode::NOT_FOUND, format!("task not found: {id}")),
    }
}

// â”€â”€â”€ /v1/ws â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub async fn websocket_unsupported() -> Response {
    fail(
        StatusCode::NOT_IMPLEMENTED,
        "WebSocket is not implemented in the Rust service. Progress is available over \
         GET /v1/jobs/:id/progress (SSE) and the job record is the authority; uploads and \
         downloads use POST /v1/upload and GET /v1/assets/:id.",
    )
}
