//! nmedia-server — Rust port of the nMedia Node service.
//!
//! Compatibility is a contract: existing consumers keep the `{success, data}`
//! envelope, the endpoint paths and the option keys. Everything behind them is
//! ours — one binary, one processor registry (no nImage/nVideo split), jobs
//! persisted per file, bounded admission, and cancellation that actually kills
//! the child.
//!
//! Configuration is `config.json` (the Node service's format, read from
//! `NMEDIA_CONFIG` or `./config.json`) with environment variables as overrides,
//! so a drop-in swap needs no file change and a process manager can drive it
//! entirely by environment.
//!
//! Engines, not reimplementations (concept §8.1): the `image` crate for images,
//! ffmpeg for audio/video and HEIC, Chromium for SVG that must match a browser.

mod assets;
mod capabilities;
mod chromium;
mod engines;
mod ffmpeg;
mod health;
mod image_processor;
mod jobs;
mod legacy;
mod logging;
mod process;
mod retention;
mod util;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tower_http::trace::TraceLayer;

use assets::AssetCache;
use engines::Engines;
use jobs::JobStore;
use util::PathList;

pub struct AppState {
    pub started: Instant,
    pub config: Config,
    pub assets: AssetCache,
    pub jobs: Arc<JobStore>,
    pub engines: Engines,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub max_file_size_bytes: u64,
    pub cache_dir: PathBuf,
    pub assets_dir: PathBuf,
    pub uploads_dir: PathBuf,
    pub jobs_dir: PathBuf,
    pub workers: usize,
    pub allowed_input: PathList,
    pub allowed_output: PathList,
    /// How long a cached asset, upload or job record survives. The Node service
    /// implied this ("persist ~1 h"); writing it down is what stops the disk
    /// filling.
    pub ttl_seconds: u64,
    /// Hard ceiling for the asset cache; oldest entries go first.
    pub cache_max_bytes: u64,
    /// Where the values came from, reported by `/health`.
    pub source: String,
    /// Logging, per the ecosystem convention (infra_nlogger.md).
    pub log_level: tracing::Level,
    pub logs_dir: PathBuf,
    pub log_retention_days: u64,
    /// Config keys we did not understand — reported at startup, never ignored silently.
    pub warnings: Vec<String>,
}

// ─── config file (Node-compatible) ───────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct FileConfig {
    server: ServerSection,
    media: MediaSection,
    cache: CacheSection,
    workers: WorkersSection,
    logging: LoggingSection,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ServerSection {
    port: Option<u16>,
    host: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct MediaSection {
    max_file_size_mb: Option<u64>,
    /// Present in the Node config; hardware selection is per-request here.
    gpu: Option<serde_json::Value>,
    /// Reported at startup rather than dropped in silence.
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
    allowed_input_paths: Option<Vec<String>>,
    allowed_output_paths: Option<Vec<String>>,
    /// Our extension: the ffmpeg and Chromium binaries to drive. The Node
    /// service embedded ffmpeg; this one is told where it lives.
    ffmpeg_path: Option<String>,
    chrome_path: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct CacheSection {
    dir: Option<String>,
    ttl: Option<u64>,
    max_size: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct WorkersSection {
    max_concurrent_tasks: Option<usize>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LoggingSection {
    level: Option<String>,
    logs_dir: Option<String>,
    retention_days: Option<u64>,
    /// Accepted and ignored on purpose: the service derives its own prefix, but
    /// the Node config sets one and a parse error would be a worse surprise.
    session_prefix: Option<String>,
    /// Anything else is reported at startup rather than dropped in silence.
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

const KNOWN_KEYS: [&str; 5] = ["server", "media", "cache", "workers", "logging"];

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let path = std::env::var("NMEDIA_CONFIG")
            .ok()
            .filter(|p| !p.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("config.json"));

        let file = if path.is_file() {
            let text = std::fs::read_to_string(&path)
                .map_err(|e| anyhow::anyhow!("cannot read {}: {e}", path.display()))?;
            // Parse to a Value first so unknown top-level keys can be named. A
            // misspelled `logging` must not be a no-op.
            let value: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| anyhow::anyhow!("invalid config {}: {e}", path.display()))?;
            let mut warnings = Vec::new();
            if let Some(object) = value.as_object() {
                for key in object.keys() {
                    if !KNOWN_KEYS.contains(&key.as_str()) {
                        warnings.push(format!(
                            "config key '{key}' is not understood by nmedia-server — ignored"
                        ));
                    }
                }
            }
            let parsed: FileConfig = serde_json::from_value(value)
                .map_err(|e| anyhow::anyhow!("invalid config {}: {e}", path.display()))?;
            // Nested keys the section structs did not recognise are reported too:
            // a silent drop inside `logging` is the same bug as a silent drop at
            // the top level.
            for (section, extras) in [
                ("logging", &parsed.logging.extra),
                ("media", &parsed.media.extra),
                ("workers", &parsed.workers.extra),
            ] {
                for key in extras.keys() {
                    warnings.push(format!(
                        "config key '{section}.{key}' is not understood by nmedia-server — ignored"
                    ));
                }
            }
            Some((parsed, warnings))
        } else {
            None
        };
        let base = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let parsed = file.as_ref().map(|(config, _)| config);
        let mut warnings = file
            .as_ref()
            .map(|(_, warnings)| warnings.clone())
            .unwrap_or_default();

        let port = env_num("NMEDIA_PORT", parsed.and_then(|c| c.server.port).unwrap_or(3500))?;
        let host = std::env::var("NMEDIA_HOST")
            .ok()
            .or_else(|| parsed.and_then(|c| c.server.host.clone()))
            .unwrap_or_else(|| "0.0.0.0".into());
        let bind: SocketAddr = format!("{host}:{port}")
            .parse()
            .map_err(|e| anyhow::anyhow!("cannot parse {host}:{port}: {e}"))?;

        let max_mb = env_num(
            "NMEDIA_MAX_FILE_MB",
            parsed.and_then(|c| c.media.max_file_size_mb).unwrap_or(2048),
        )?;
        let workers = env_num(
            "NMEDIA_WORKERS",
            parsed
                .and_then(|c| c.workers.max_concurrent_tasks)
                .unwrap_or(4),
        )?;
        if workers == 0 {
            anyhow::bail!("maxConcurrentTasks must be at least 1");
        }

        let cache_dir = std::env::var("NMEDIA_CACHE_DIR")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| parsed.and_then(|c| c.cache.dir.clone()).map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("./cache"));
        let cache_dir = if cache_dir.is_absolute() {
            cache_dir
        } else {
            base.join(cache_dir)
        };

        let ttl_seconds = env_num(
            "NMEDIA_CACHE_TTL",
            parsed.and_then(|c| c.cache.ttl).unwrap_or(3600),
        )?;
        let cache_max_bytes = env_num(
            "NMEDIA_CACHE_MAX_BYTES",
            parsed
                .and_then(|c| c.cache.max_size)
                .unwrap_or(10 * 1024 * 1024 * 1024),
        )?;

        // Engine paths: env wins over config.json. Setting them in the process
        // environment is how `ffmpeg::ffmpeg_path` and `chromium` resolve.
        if let Some(ffmpeg) = parsed.and_then(|c| c.media.ffmpeg_path.clone()) {
            if std::env::var_os("NMEDIA_FFMPEG").is_none() {
                std::env::set_var("NMEDIA_FFMPEG", absolute(&base, &ffmpeg));
            }
            if std::env::var_os("NMEDIA_FFPROBE").is_none() {
                let probe = Path::new(&ffmpeg).with_file_name(format!(
                    "ffprobe{}",
                    std::env::consts::EXE_SUFFIX
                ));
                std::env::set_var(
                    "NMEDIA_FFPROBE",
                    absolute(&base, &probe.to_string_lossy()),
                );
            }
        }
        if let Some(chrome) = parsed.and_then(|c| c.media.chrome_path.clone()) {
            if std::env::var_os("NMEDIA_CHROME").is_none() {
                std::env::set_var("NMEDIA_CHROME", absolute(&base, &chrome));
            }
        }

        let allowed_input = PathList::from_config_or_env(
            "NMEDIA_ALLOWED_INPUT",
            parsed.and_then(|c| c.media.allowed_input_paths.clone()),
        );
        let allowed_output = PathList::from_config_or_env(
            "NMEDIA_ALLOWED_OUTPUT",
            parsed.and_then(|c| c.media.allowed_output_paths.clone()),
        );

        Ok(Self {
            bind,
            max_file_size_bytes: max_mb * 1024 * 1024,
            assets_dir: cache_dir.join("assets"),
            uploads_dir: cache_dir.join("uploads"),
            jobs_dir: cache_dir.join("jobs"),
            cache_dir,
            workers,
            allowed_input,
            allowed_output,
            ttl_seconds,
            cache_max_bytes,
            log_level: parse_level(
                std::env::var("LOG_LEVEL")
                    .ok()
                    .or_else(|| parsed.and_then(|c| c.logging.level.clone()))
                    .as_deref(),
                &mut warnings,
            ),
            logs_dir: {
                let dir = parsed
                    .and_then(|c| c.logging.logs_dir.clone())
                    .unwrap_or_else(|| String::from("./logs"));
                PathBuf::from(absolute(&base, &dir))
            },
            log_retention_days: env_num(
                "LOG_RETENTION_DAYS",
                parsed
                    .and_then(|c| c.logging.retention_days)
                    .unwrap_or(1),
            )?,
            warnings,
            source: if file.is_some() {
                path.display().to_string()
            } else {
                "environment only (no config.json found)".to_string()
            },
        })
    }
}

fn parse_level(value: Option<&str>, warnings: &mut Vec<String>) -> tracing::Level {
    match value.map(|v| v.trim().to_ascii_lowercase()) {
        None => tracing::Level::INFO,
        Some(level) => match level.as_str() {
            "debug" | "trace" => tracing::Level::DEBUG,
            "info" => tracing::Level::INFO,
            "warn" | "warning" => tracing::Level::WARN,
            "error" => tracing::Level::ERROR,
            other => {
                warnings.push(format!(
                    "log level '{other}' is not one of debug|info|warn|error — using info"
                ));
                tracing::Level::INFO
            }
        },
    }
}

fn absolute(base: &Path, value: &str) -> String {    let path = PathBuf::from(value);
    if path.is_absolute() {
        path.to_string_lossy().to_string()
    } else {
        base.join(path).to_string_lossy().to_string()
    }
}

fn env_num<T>(key: &str, fallback: T) -> anyhow::Result<T>
where
    T: std::str::FromStr + Copy,
{
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => value
            .trim()
            .parse()
            .map_err(|_| anyhow::anyhow!("{key} must be a number, got '{value}'")),
        _ => Ok(fallback),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::load()?;
    // Logging first: config warnings go through it, and the convention wants a
    // session id on every line from the first one.
    logging::init(
        "ms",
        &config.logs_dir,
        config.log_level,
        config.log_retention_days,
    )?;
    for warning in &config.warnings {
        tracing::warn!("{warning}");
    }
    tracing::info!(
        config = %config.source,
        ttl = config.ttl_seconds,
        workers = config.workers,
        "configuration loaded"
    );
    let assets = AssetCache::open(&config.assets_dir.to_string_lossy())?;
    let jobs = JobStore::open(config.jobs_dir.clone(), config.workers)?;
    std::fs::create_dir_all(&config.uploads_dir)?;

    // Engines are probed once: a capability is a fact about the binary we will
    // run, not a claim in a config file.
    let engine_report = Engines::probe();
    match &engine_report.ffmpeg {
        Some(path) => tracing::info!(
            ffmpeg = %path.display(),
            version = engine_report.ffmpeg_version.as_deref().unwrap_or("unknown"),
            hwaccels = engine_report.hwaccels.len(),
            hardware_encoders = engine_report.hardware_encoders().len(),
            "engine ready"
        ),
        None => tracing::warn!("no ffmpeg found — audio, video and HEIC will refuse"),
    }
    match &engine_report.chrome {
        Some(path) => tracing::info!(chrome = %path.display(), "browser engine ready"),
        None => tracing::warn!("no Chromium found — SVG falls back to resvg (approximate)"),
    }

    let bind = config.bind;
    let capacity = jobs.capacity();
    let state = Arc::new(AppState {
        started: Instant::now(),
        config,
        assets,
        jobs,
        engines: engine_report,
    });

    // Retention loop: assets, uploads and job records all age out. Without this
    // the cache grows until the disk says no.
    retention::spawn(state.clone());

    let app = Router::new()
        .route("/health", get(health::health))
        .route("/v1/capabilities", get(capabilities::capabilities))
        .route(
            "/v1/upload",
            post(process::upload).layer(DefaultBodyLimit::disable()),
        )
        .route("/v1/process", post(process::process))
        .route("/v1/process/image", post(legacy::image))
        .route("/v1/process/image/crop", post(legacy::image_crop))
        .route("/v1/process/audio", post(legacy::audio))
        .route("/v1/process/video", post(legacy::video))
        .route("/v1/audio/probe", post(legacy::audio_probe))
        .route("/v1/video/probe", post(legacy::video_probe))
        .route("/v1/jobs", get(jobs::list_jobs))
        .route("/v1/jobs/active", get(jobs::list_active))
        .route("/v1/jobs/:id", get(jobs::get_job).delete(jobs::cancel_job))
        .route("/v1/jobs/:id/progress", get(jobs::progress))
        .route("/v1/tasks", post(legacy::create_task).get(legacy::list_tasks))
        .route("/v1/tasks/stats", get(legacy::task_stats))
        .route(
            "/v1/tasks/:id",
            get(legacy::get_task).delete(legacy::cancel_task),
        )
        .route("/v1/tasks/:id/result", get(legacy::task_result))
        .route("/v1/assets", get(assets::list).delete(assets::clear_all))
        .route(
            "/v1/assets/:id",
            get(assets::download).delete(assets::delete_one),
        )
        .route("/v1/assets/:id/metadata", get(assets::metadata))
        .route("/v1/thumbnail/*path", get(legacy::thumbnail))
        .route("/v1/info/*path", get(legacy::info))
        .route("/v1/ws", get(legacy::websocket_unsupported))
        .with_state(state)
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|e| anyhow::anyhow!("cannot bind {bind}: {e}"))?;
    tracing::info!(bind = %bind, workers = capacity, "nmedia-server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            let killed = ffmpeg::kill_all_children();
            if killed > 0 {
                tracing::info!(killed, "stopped running media children");
            }
        })
        .await?;
    Ok(())
}

/// `{ "success": true, "data": … }` — the Node service's envelope.
pub fn ok<T: serde::Serialize>(data: T) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "success": true, "data": data }))
}
