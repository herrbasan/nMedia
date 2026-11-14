//! GET /v1/capabilities — one service, one tree.
//!
//! The Node service splits itself into `nImage` and `nVideo` processors, each a
//! separate module with its own capability tree, and blames that split for most
//! of its shape. This port has **no split**: one binary, one processor registry,
//! one `data.service` tree. Engines are still engines — but "ffmpeg" is an
//! implementation detail of the audio and video ops, not a subsystem with its own
//! API surface.
//!
//! Compatibility kept: the `{ success, data }` envelope, `data.service.endpoints`,
//! `data.service.features`, `?section=` subsetting, and every endpoint's path.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

use crate::health;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct CapabilitiesQuery {
    #[serde(default)]
    section: Option<String>,
    /// Accepted for compatibility with callers that still ask for a module
    /// slice. There is nothing to slice any more — the answer is the unified tree.
    #[serde(default)]
    module: Option<String>,
}

pub async fn capabilities(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CapabilitiesQuery>,
) -> Json<serde_json::Value> {
    let _ = &query.module;

    // A section used to be sliced out of a fully assembled tree — endpoints,
    // features, health, every encoder list — with the rest thrown away. Build
    // only what was asked for; a section answers with that part of the tree.
    match query.section.as_deref() {
        Some("endpoints") => crate::ok(endpoints()),
        Some("features") => crate::ok(features(&state)),
        Some("health") => crate::ok(health::snapshot(&state)),
        Some("config") => crate::ok(config(&state)),
        Some(other) => Json(serde_json::json!({
            "success": false,
            "error": format!("unknown section '{other}' — one of: endpoints, features, health, config"),
        })),
        None => crate::ok(serde_json::json!({ "service": build(&state) })),
    }
}

fn build(state: &AppState) -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "implementation": "nmedia-server (Rust port, unified)",
        "endpoints": endpoints(),
        "features": features(state),
        "health": health::snapshot(state),
        "engine": {
            "ffmpeg": state.engines.ffmpeg.as_ref().map(|p| p.display().to_string()),
            "ffmpegVersion": state.engines.ffmpeg_version,
            "hwaccels": state.engines.hwaccels,
            "chrome": state.engines.chrome.as_ref().map(|p| p.display().to_string()),
            "chromeVersion": state.engines.chrome_version,
            "chromeSource": state.engines.chrome_source,
            "filters": state.engines.filter_count,
        },
        "video": {
            "available": state.engines.ffmpeg.is_some(),
            "encoders": {
                "h264": state.engines.encoders_for("h264").iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
                "hevc": state.engines.encoders_for("hevc").iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
                "av1": state.engines.encoders_for("av1").iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
                "vp9": state.engines.encoders_for("vp9").iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
            },
            "hardwareEncoders": state.engines.hardware_encoders().iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
        },
        "retention": {
            "ttlSeconds": state.config.ttl_seconds,
            "cacheMaxBytes": state.config.cache_max_bytes,
        },
        "config": config(state),
    })
}

fn config(state: &AppState) -> serde_json::Value {
    serde_json::json!({
        "maxFileSizeBytes": state.config.max_file_size_bytes,
        "maxFileSizeMb": state.config.max_file_size_bytes / (1024 * 1024),
        // What a buffered JSON body may weigh; base64 media needs 4/3 of the
        // file cap, and a caller sizing a request should read this rather than
        // discover it as a 413.
        "maxBodyBytes": crate::body_limit_bytes(state.config.max_file_size_bytes),
        "cacheDir": state.config.cache_dir.to_string_lossy(),
        "bind": state.config.bind.to_string(),
        "workerProcesses": state.config.workers,
        "workersMode": "process",
        "messageTransport": "sse",
        "allowedInputPaths": path_list(&state.config.allowed_input),
        "allowedOutputPaths": path_list(&state.config.allowed_output),
    })
}

fn path_list(list: &crate::util::PathList) -> Vec<String> {
    if list.all {
        vec!["*".to_string()]
    } else {
        list.roots.iter().map(|p| p.display().to_string()).collect()
    }
}

/// One processor registry. `available` is the honest field a caller should read;
/// `engine` names what would run the ops, so a missing binary is visible before a
/// job is queued rather than after it fails.
fn features(state: &AppState) -> serde_json::Value {
    let ffmpeg = state.engines.ffmpeg.is_some();
    // The probed engine, not a fresh filesystem probe: /v1/capabilities must
    // describe the binary that will actually render.
    let chromium = state.engines.chrome.is_some();
    serde_json::json!({
        "processors": [
            {
                "name": "image",
                "available": true,
                "engine": "rust image crate + fast_image_resize + image-webp/libwebp + resvg + chromium",
                "operations": ["resize", "crop", "format conversion", "rotate", "flip", "flop", "grayscale", "blur", "normalize"],
                "formats": crate::image_processor::supported_outputs(),
                "inputs": crate::image_processor::supported_inputs(),
                "svg": {
                    "defaultEngine": if chromium { "chromium" } else { "resvg" },
                    "engines": if chromium {
                        serde_json::json!(["chromium", "resvg"])
                    } else {
                        serde_json::json!(["resvg"])
                    },
                    "browserVersion": state.engines.chrome_version,
                    "browserSource": state.engines.chrome_source,
                    "resvgLimits": "no CSS custom properties (var()), no @media (prefers-color-scheme), font weights degrade to regular, textLength spacing approximated",
                    "option": "engine: chromium | resvg",
                },
            },
            {
                "name": "audio",
                "available": ffmpeg,
                "engine": "ffmpeg",
                "operations": ["transcode", "resample", "channel conversion"],
                "formats": ["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"],
                "reason": if ffmpeg { serde_json::Value::Null } else { serde_json::Value::from("ffmpeg not found on PATH; set NMEDIA_FFMPEG") },
            },
            {
                "name": "video",
                "available": ffmpeg,
                "engine": "ffmpeg",
                "operations": ["extract_audio", "extract_keyframes", "transcode"],
                "formats": ["mp4", "webm", "mkv", "mov"],
                "reason": if ffmpeg { serde_json::Value::Null } else { serde_json::Value::from("ffmpeg not found on PATH; set NMEDIA_FFMPEG") },
            },
        ],
        "utilities": [
            { "name": "thumbnail", "description": "Best-effort thumbnail for images", "synchronous": true },
            { "name": "info", "description": "Metadata extraction for images, ffprobe for media", "synchronous": true },
        ],
        "transports": ["http", "sse"],
        "envelope": "{ success, data }",
    })
}

const ENDPOINTS: &[(&str, &str, &str)] = &[
    ("GET", "/health", "Health check with processor readiness"),
    ("POST", "/v1/upload", "Stream raw binary upload. Returns fileId"),
    ("POST", "/v1/process", "Start processing from fileId or input_path. Returns jobId"),
    ("GET", "/v1/jobs", "List all jobs"),
    ("GET", "/v1/jobs/active", "List active (queued/processing) jobs"),
    ("GET", "/v1/jobs/:jobId", "Get job status and progress"),
    ("GET", "/v1/jobs/:jobId/progress", "SSE progress stream"),
    ("DELETE", "/v1/jobs/:jobId", "Cancel a queued or processing job"),
    ("GET", "/v1/assets", "List cached assets"),
    ("GET", "/v1/assets/:id", "Download asset file"),
    ("GET", "/v1/assets/:id/metadata", "Get asset metadata"),
    ("DELETE", "/v1/assets/:id", "Delete specific asset"),
    ("DELETE", "/v1/assets", "Clear all assets"),
    ("GET", "/v1/thumbnail/*", "Best-effort thumbnail for any media file"),
    ("GET", "/v1/info/*", "Detailed metadata for any media file"),
    ("GET", "/v1/capabilities", "Query service capabilities"),
];

/// Flat tuple table → the object shape consumers parse. A flat list is what makes
/// a contract diff readable; the serialisation is the only thing that nests.
fn endpoints() -> serde_json::Value {
    serde_json::Value::Array(
        ENDPOINTS
            .iter()
            .map(|(method, path, description)| {
                serde_json::json!({ "method": method, "path": path, "description": description })
            })
            .collect(),
    )
}
