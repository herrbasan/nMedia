//! `POST /v1/upload` and `POST /v1/process`, plus the job executor they feed.
//!
//! Uploads stream from the request body to disk with our own byte cap â€” a
//! buffered `Bytes` extractor would hold a 2 GB limit in RAM. Processing is
//! admitted against a bounded worker pool (429 when full), runs off the request
//! thread, and reports through the job store.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio_stream::StreamExt;

use crate::assets::{self, AssetMeta};
use crate::ffmpeg::{self, AudioOptions, VideoOptions};
use crate::image_processor::{self, ImageOptions};
use crate::util;
use crate::AppState;

const VALID_PROCESSORS: [&str; 3] = ["image", "audio", "video"];
const VALID_VIDEO_MODES: [&str; 3] = ["extract_audio", "extract_keyframes", "transcode"];

#[derive(Debug, Deserialize)]
pub struct ProcessRequest {
    #[serde(default)]
    pub input_path: Option<String>,
    #[serde(default)]
    pub file_id: Option<String>,
    pub processor: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub options: Option<Value>,
    #[serde(default)]
    pub output_path: Option<String>,
}

fn bad(message: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "success": false, "error": message.into() })),
    )
        .into_response()
}

// â”€â”€â”€ upload â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub async fn upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let filename = headers
        .get("x-original-filename")
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            Path::new(v)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "upload.bin".into())
        })
        .unwrap_or_else(|| "upload.bin".into());

    if let Some(length) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        if length > state.config.max_file_size_bytes {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(serde_json::json!({
                    "success": false,
                    "error": format!("upload is {length} bytes, over the {} byte limit", state.config.max_file_size_bytes),
                })),
            )
                .into_response();
        }
    }

    let id = util::id();
    let dir = state.config.uploads_dir.join(&id);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return internal(&format!("cannot create upload directory: {e}"));
    }
    let path = dir.join(&filename);
    let mut file = match tokio::fs::File::create(&path).await {
        Ok(f) => f,
        Err(e) => return internal(&format!("cannot create {}: {e}", path.display())),
    };

    let mut written: u64 = 0;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => return bad(format!("upload stream failed: {e}")),
        };
        written += chunk.len() as u64;
        if written > state.config.max_file_size_bytes {
            drop(file);
            let _ = std::fs::remove_dir_all(&dir);
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(serde_json::json!({
                    "success": false,
                    "error": format!("upload exceeded the {} byte limit", state.config.max_file_size_bytes),
                })),
            )
                .into_response();
        }
        if let Err(e) = file.write_all(&chunk).await {
            return internal(&format!("cannot write upload: {e}"));
        }
    }
    if let Err(e) = file.flush().await {
        return internal(&format!("cannot flush upload: {e}"));
    }
    drop(file);

    crate::ok(serde_json::json!({
        "fileId": id,
        "filename": filename,
        "path": path.to_string_lossy(),
        "size": written,
        "contentType": util::mime_for_ext(&util::ext_of(&path)),
    }))
    .into_response()
}

// â”€â”€â”€ process â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub async fn process(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProcessRequest>,
) -> Response {
    match validate(&state, &request) {
        Ok((input, options, output_path)) => start(state, request, input, options, output_path).await,
        Err(response) => response,
    }
}

fn validate(
    state: &AppState,
    request: &ProcessRequest,
) -> Result<(InputRef, Value, Option<PathBuf>), Response> {
    if !VALID_PROCESSORS.contains(&request.processor.as_str()) {
        return Err(bad(format!(
            "invalid processor '{}' â€” one of: {}",
            request.processor,
            VALID_PROCESSORS.join(", ")
        )));
    }
    match (&request.input_path, &request.file_id) {
        (Some(_), Some(_)) => return Err(bad("provide either input_path or fileId, not both")),
        (None, None) => return Err(bad("either input_path or fileId is required")),
        _ => {}
    }
    if request.mode.is_some() && request.processor != "video" {
        return Err(bad("mode is only valid for the video processor"));
    }
    if let Some(mode) = &request.mode {
        if !VALID_VIDEO_MODES.contains(&mode.as_str()) {
            return Err(bad(format!(
                "invalid video mode '{mode}' â€” one of: {}",
                VALID_VIDEO_MODES.join(", ")
            )));
        }
    }

    // Option keys are validated at the boundary: a typo must fail here, not
    // inside a job that then returns a default-processed asset.
    let options = request.options.clone().unwrap_or(Value::Object(Default::default()));
    match request.processor.as_str() {
        "image" => {
            let parsed: ImageOptions = serde_json::from_value(options.clone())
                .map_err(|e| bad(format!("unknown image option(s): {e}")))?;
            image_processor::validate(&parsed).map_err(bad)?;
        }
        "audio" => {
            let parsed: AudioOptions = serde_json::from_value(options.clone())
                .map_err(|e| bad(format!("unknown audio option(s): {e}")))?;
            if let Some(format) = parsed.format.as_deref() {
                ffmpeg::validate_audio_format(format).map_err(bad)?;
            }
        }
        _ => {
            let parsed: VideoOptions = serde_json::from_value(options.clone())
                .map_err(|e| bad(format!("unknown video option(s): {e}")))?;
            if parsed.cli_command.is_some() {
                return Err(bad(
                    "cli_command (raw ffmpeg passthrough) is not available in the Rust service: \
                     arguments are built as argv arrays and never taken from input",
                ));
            }
            if let Some(format) = parsed.format.as_deref() {
                // extract_audio writes an audio container; every other video
                // mode writes a video container. Validating the wrong one is how
                // `format: "mp3"` got refused on a mode that needs it.
                if request.mode.as_deref() == Some("extract_audio") {
                    ffmpeg::validate_audio_format(format).map_err(bad)?;
                } else {
                    ffmpeg::validate_video_format(format).map_err(bad)?;
                }
            }
        }
    }
    if request.processor == "audio" || (request.processor == "video" && request.mode.as_deref() == Some("extract_audio")) {
        if ffmpeg::ffmpeg_path().is_none() {
            return Err(unavailable("ffmpeg not found: set NMEDIA_FFMPEG or put ffmpeg on PATH"));
        }
    }
    if request.processor == "video" && ffmpeg::ffmpeg_path().is_none() {
        return Err(unavailable("ffmpeg not found: set NMEDIA_FFMPEG or put ffmpeg on PATH"));
    }

    let input = match (&request.file_id, &request.input_path) {
        (Some(file_id), _) => {
            // Only an id this service minted names an upload; anything else is a
            // path, not a name, and must never reach the join below.
            if !crate::util::is_valid_id(file_id) {
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "success": false, "error": format!("unknown fileId: {file_id}") })),
                )
                    .into_response());
            }
            let path = state.config.uploads_dir.join(file_id);
            let found = std::fs::read_dir(&path)
                .ok()
                .and_then(|mut rd| rd.next())
                .and_then(|e| e.ok())
                .map(|e| e.path());
            match found {
                Some(p) => InputRef::Path(p),
                None => {
                    return Err((
                        StatusCode::NOT_FOUND,
                        Json(serde_json::json!({ "success": false, "error": format!("unknown fileId: {file_id}") })),
                    )
                        .into_response())
                }
            }
        }
        (None, Some(input_path)) => {
            let p = PathBuf::from(input_path);
            // Canonicalised *and* allow-listed: a symlink that resolves outside
            // the roots is refused here, not left to the engine.
            let checked = state
                .config
                .allowed_input
                .check_existing(&p, "input_path")
                .map_err(bad)?;
            InputRef::Path(checked)
        }
        (None, None) => unreachable!("validated above"),
    };

    let output_path = match request.output_path.as_deref() {
        Some(raw) => Some(
            state
                .config
                .allowed_output
                .check_for_write(&PathBuf::from(raw), "output_path")
                .map_err(bad)?,
        ),
        None => None,
    };

    Ok((input, options, output_path))
}

enum InputRef {
    Path(PathBuf),
}

async fn start(
    state: Arc<AppState>,
    request: ProcessRequest,
    input: InputRef,
    options: Value,
    output_path: Option<PathBuf>,
) -> Response {
    let InputRef::Path(input_path) = input;
    let input_label = input_path.to_string_lossy().to_string();

    // The permit is reserved here and travels with the job; dropping it at
    // admission would let a burst pass the bound and queue behind it.
    let (job, permit) = match state
        .jobs
        .admit(&request.processor, request.mode.as_deref(), &input_label)
        .await
    {
        Ok(pair) => pair,
        Err(()) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({
                    "success": false,
                    "error": format!(
                        "worker pool is full ({} concurrent jobs) - retry when a job finishes or poll /v1/jobs/active",
                        state.jobs.capacity()
                    ),
                })),
            )
                .into_response()
        }
    };

    let job_id = job.id.clone();
    let state_for_task = state.clone();
    let processor = request.processor.clone();
    let mode = request.mode.clone();

    tokio::spawn(async move {
        run_job(
            state_for_task,
            job_id,
            permit,
            input_path,
            processor,
            mode,
            options,
            output_path,
        )
        .await;
    });

    crate::ok(serde_json::json!({
        "jobId": job.id,
        "status": "queued",
        "processor": request.processor,
        "progress": 0,
        "progressUrl": format!("/v1/jobs/{}/progress", job.id),
    }))
    .into_response()
}

#[allow(clippy::too_many_arguments)]
async fn run_job(
    state: Arc<AppState>,
    job_id: String,
    _permit: tokio::sync::OwnedSemaphorePermit,
    input: PathBuf,
    processor: String,
    mode: Option<String>,
    options: Value,
    output_path: Option<PathBuf>,
) {
    // CAS queued -> processing: a job cancelled between admission and here stays
    // cancelled instead of being resurrected by its own executor.
    let Some(_job) = state.jobs.begin(&job_id) else {
        return;
    };
    let cancel = state.jobs.notify_handle(&job_id);

    let stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "asset".into());

    let outcome: Result<Produced, String> = match processor.as_str() {
        "image" => process_image(&state, &input, &stem, &options, &cancel).await,
        "audio" => process_audio(&state, &input, &stem, &options, &cancel).await,
        _ => process_video(&state, &input, &stem, mode.as_deref(), &options, &cancel).await,
    };

    match outcome {
        Ok(produced) => {
            state.jobs.mark(&job_id, "processing", 90, "storing asset");
            match store(&state, produced, &job_id) {
                Ok((asset_id, cache_path)) => {
                    // Publishing is part of success: a caller that asked for a
                    // path and did not get it must not see "completed". The cache
                    // copy stays referenced, so nothing is lost and the publish
                    // can be retried without rerunning the engine.
                    if let Some(destination) = output_path.as_deref() {
                        if let Err(e) = publish(&cache_path, destination) {
                            state.jobs.fail_keeping(
                                &job_id,
                                &format!(
                                    "processed, but cannot publish to {}: {e}",
                                    destination.display()
                                ),
                                asset_id,
                            );
                            return;
                        }
                    }
                    let reported = output_path
                        .as_deref()
                        .unwrap_or(cache_path.as_path())
                        .to_string_lossy()
                        .to_string();
                    state.jobs.finish(&job_id, asset_id, Some(reported));
                }
                Err(e) => {
                    state.jobs.fail(&job_id, &e);
                }
            }
        }
        Err(message) if message == "cancelled" => {
            state.jobs.finish_cancelled(&job_id);
        }
        Err(message) => {
            state.jobs.fail(&job_id, &message);
        }
    }
}

/// Copy into a sibling temp file, then move it over the destination: a failed
/// transcode never truncates a file the caller already had.
fn publish(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "destination has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    let name = destination
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".into());
    let temp = parent.join(format!(".{name}.tmp-{}", util::id()));
    std::fs::copy(source, &temp).map_err(|e| format!("cannot write {}: {e}", temp.display()))?;
    // Windows refuses to rename over an existing file; replacing explicitly
    // preserves the overwrite behaviour the Node service had (-y).
    if destination.exists() {
        std::fs::remove_file(destination)
            .map_err(|e| format!("cannot replace {}: {e}", destination.display()))?;
    }
    std::fs::rename(&temp, destination).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("cannot move into place at {}: {e}", destination.display())
    })
}
enum Produced {
    Asset {
        meta: AssetMeta,
        bytes: Option<Vec<u8>>,
        file: Option<PathBuf>,
    },
    /// Keyframe extraction produces a directory, not one file. The job reports
    /// the path; registering the first frame as "the" asset would be a lie.
    Directory(PathBuf),
}

fn store(state: &AppState, produced: Produced, job_id: &str) -> Result<(Option<String>, PathBuf), String> {
    match produced {
        Produced::Directory(path) => {
            let count = std::fs::read_dir(&path).map(|rd| rd.count()).unwrap_or(0);
            tracing::info!(job = job_id, dir = %path.display(), frames = count, "keyframes written");
            Ok((None, path))
        }
        Produced::Asset { mut meta, bytes, file } => {
            meta.job_id = Some(job_id.to_string());
            let saved = match (bytes, file) {
                (Some(bytes), _) => state
                    .assets
                    .put(meta, &bytes)
                    .map_err(|e| format!("cannot store asset: {e}"))?,
                (None, Some(file)) => state
                    .assets
                    .register(meta, &file)
                    .map_err(|e| format!("cannot register asset: {e}"))?,
                (None, None) => return Err("processor produced neither bytes nor a file".into()),
            };
            let id = saved.id.clone();
            Ok((Some(id), state.assets.path_of(&saved)))
        }
    }
}

// â”€â”€â”€ per-processor work â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async fn process_image(
    state: &AppState,
    input: &Path,
    stem: &str,
    options: &Value,
    cancel: &tokio::sync::Notify,
) -> Result<Produced, String> {
    let opts: ImageOptions = serde_json::from_value(options.clone())
        .map_err(|e| format!("invalid image options: {e}"))?;

    let head = std::fs::File::open(input)
        .and_then(|mut f| {
            use std::io::Read;
            let mut buf = vec![0u8; 16];
            let n = f.read(&mut buf)?;
            buf.truncate(n);
            Ok::<Vec<u8>, std::io::Error>(buf)
        })
        .map_err(|e| format!("cannot read {}: {e}", input.display()))?;

    // HEIC/HEIF: no Rust decoder here, and ffmpeg is the one that measured
    // 4.6x faster than the alternatives with identical detail (see §13.2d).
    if ffmpeg::is_heif(&head) {
        let (rgb, width, height) = ffmpeg::decode_image_rgb(input, cancel).await?;
        let buffer = image::RgbImage::from_raw(width, height, rgb)
            .ok_or_else(|| "ffmpeg returned a pixel buffer of the wrong size".to_string())?;
        let img = image::DynamicImage::ImageRgb8(buffer);
        return tokio::task::spawn_blocking(move || image_processor::process_pixels(img, &opts))
            .await
            .map_err(|e| format!("image worker panicked: {e}"))?
            .map(|processed| Produced::Asset {
                meta: assets::new_meta(
                    &format!("{stem}.{}", processed.ext),
                    processed.mime,
                    Some(processed.width),
                    Some(processed.height),
                ),
                bytes: Some(processed.bytes),
                file: None,
            });
    }

    let work = state.config.cache_dir.join("work");
    let source = input.to_path_buf();
    let processed = tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(&source).map_err(|e| format!("cannot read {}: {e}", source.display()))?;
        image_processor::process(&bytes, &opts, &work)
    })
    .await
    .map_err(|e| format!("image worker panicked: {e}"))??;

    Ok(Produced::Asset {
        meta: assets::new_meta(
            &format!("{stem}.{}", processed.ext),
            processed.mime,
            Some(processed.width),
            Some(processed.height),
        ),
        bytes: Some(processed.bytes),
        file: None,
    })
}

async fn process_audio(
    state: &AppState,
    input: &Path,
    stem: &str,
    options: &Value,
    cancel: &tokio::sync::Notify,
) -> Result<Produced, String> {
    let opts: AudioOptions = serde_json::from_value(options.clone())
        .map_err(|e| format!("invalid audio options: {e}"))?;
    let format = opts.format.clone().unwrap_or_else(|| "mp3".into());
    let ext = ffmpeg::default_ext(&format);
    let target = state.config.assets_dir.join(format!("{}.{ext}", util::id()));

    ffmpeg::transcode_audio(input, &target, &opts, cancel).await?;
    Ok(Produced::Asset {
        meta: assets::new_meta(&format!("{stem}.{ext}"), util::mime_for_ext(ext), None, None),
        bytes: None,
        file: Some(target),
    })
}

async fn process_video(
    state: &AppState,
    input: &Path,
    stem: &str,
    mode: Option<&str>,
    options: &Value,
    cancel: &tokio::sync::Notify,
) -> Result<Produced, String> {
    let opts: VideoOptions = serde_json::from_value(options.clone())
        .map_err(|e| format!("invalid video options: {e}"))?;
    match mode.unwrap_or("transcode") {
        "extract_audio" => {
            let audio = AudioOptions {
                sample_rate: None,
                channels: None,
                format: opts.format.clone(),
                audio_bitrate: opts.audio_bitrate.clone(),
            };
            let format = audio.format.clone().unwrap_or_else(|| "mp3".into());
            let ext = ffmpeg::default_ext(&format);
            let target = state.config.assets_dir.join(format!("{}.{ext}", util::id()));
            ffmpeg::extract_audio(input, &target, &audio, cancel).await?;
            Ok(Produced::Asset {
                meta: assets::new_meta(&format!("{stem}.{ext}"), util::mime_for_ext(ext), None, None),
                bytes: None,
                file: Some(target),
            })
        }
        "extract_keyframes" => {
            let dir = state.config.assets_dir.join(format!("{}-frames", util::id()));
            let fps = opts.fps.unwrap_or(1.0);
            ffmpeg::extract_keyframes(input, &dir, fps, cancel).await?;
            // Keyframes are many files, not one asset; the job reports the
            // directory and the count, and registers no asset rather than
            // pretending the first frame represents the set.
            Ok(Produced::Directory(dir))
        }
        _ => {
            let format = opts.format.clone().unwrap_or_else(|| "mp4".into());
            let ext = ffmpeg::default_ext(&format);
            let target = state.config.assets_dir.join(format!("{}.{ext}", util::id()));
            ffmpeg::transcode_video(input, &target, &opts, cancel).await?;
            Ok(Produced::Asset {
                meta: assets::new_meta(&format!("{stem}.{ext}"), util::mime_for_ext(ext), None, None),
                bytes: None,
                file: Some(target),
            })
        }
    }
}

fn internal(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "success": false, "error": message })),
    )
        .into_response()
}

fn unavailable(message: &str) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({ "success": false, "error": message })),
    )
        .into_response()
}
