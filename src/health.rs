//! GET /health — compatible, and better where better costs nothing.
//!
//! The Node service returns `{ status, uptime, processors, checkedAt, backends }`.
//! Consumers parse `status` and `processors` (a map of `"ready"` / `"unavailable"`
//! strings), so those keep their types and meaning. Everything else is ours:
//! `details` says *why* a lane is not ready instead of leaving a bare word, and
//! `implementation` names the port so a caller can tell which service answered.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::Json;

use crate::AppState;

pub async fn health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(snapshot(&state))
}

pub fn snapshot(state: &AppState) -> serde_json::Value {
    // Readiness is a probe, not a slogan: the image lane is this binary, the
    // audio/video lanes are ffmpeg, and a missing engine is named here rather
    // than discovered at job time.
    // The probed engine is the single source of truth. A per-request re-probe can
    // disagree with backends.ffmpeg in the same payload, and costs a PATH walk.
    let ffmpeg = state.engines.ffmpeg.as_ref();
    let ffmpeg_ready = ffmpeg.is_some();
    let lanes: [(&str, String, bool, Option<&str>); 3] = [
        ("image", "rust image crate".into(), true, None),
        (
            "audio",
            ffmpeg
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "ffmpeg".into()),
            ffmpeg_ready,
            if ffmpeg_ready { None } else { Some("ffmpeg not found on PATH; set NMEDIA_FFMPEG") },
        ),
        (
            "video",
            ffmpeg
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "ffmpeg".into()),
            ffmpeg_ready,
            if ffmpeg_ready { None } else { Some("ffmpeg not found on PATH; set NMEDIA_FFMPEG") },
        ),
    ];
    // `status` keeps the Node meaning ("any lane ready"), which is a constant
    // while the image lane is local. `ready` is the honest gate: every lane up.
    let all_ready = lanes.iter().all(|(_, _, ready, _)| *ready);
    let mut processors = serde_json::Map::new();
    let mut details = serde_json::Map::new();
    for (lane, backend, ready, reason) in lanes {
        processors.insert(
            lane.into(),
            serde_json::Value::from(if ready { "ready" } else { "unavailable" }),
        );
        details.insert(
            lane.into(),
            serde_json::json!({ "backend": backend, "ready": ready, "reason": reason }),
        );
    }

    serde_json::json!({
        "status": if processors.values().any(|v| v == "ready") { "ok" } else { "starting" },
        "ready": all_ready,
        "uptime": state.started.elapsed().as_secs(),
        "processors": processors,
        "checkedAt": rfc3339_now(),
        "backends": {
            "image": { "engine": "rust image crate" },
            "ffmpeg": state.engines.ffmpeg.as_ref().map(|p| p.display().to_string()),
            "ffmpegVersion": state.engines.ffmpeg_version,
            "chrome": state.engines.chrome.as_ref().map(|p| p.display().to_string()),
            "chromeVersion": state.engines.chrome_version,
            "chromeSource": state.engines.chrome_source,
        },
        "details": details,
        "implementation": {
            "name": "nmedia-server",
            "language": "rust",
            "version": env!("CARGO_PKG_VERSION"),
            "configSource": state.config.source,
        },
    })
}

fn rfc3339_now() -> String {
    let secs = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_secs(),
        // A pre-1970 clock makes every timestamp a plausible-looking lie; say so.
        Err(e) => {
            tracing::warn!(?e, "system clock is before UNIX_EPOCH; checkedAt is not meaningful");
            0
        }
    };
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    // `z` is `days + 719_468` with days from a u64, so it can never be negative.
    let era = z / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}
