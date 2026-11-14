//! Retention: assets, uploads and job records all age out.
//!
//! The Node service kept a 1-hour cache and said so in its own tool text; the
//! Rust port had no eviction at all, which turns a media service into a disk
//! leak the moment it is used in bulk. This loop is the difference between the
//! two, and it runs on a timer rather than at a request boundary so a quiet
//! service still cleans up after itself.

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use crate::AppState;

const SWEEP_INTERVAL: Duration = Duration::from_secs(300);

pub struct SweepReport {
    pub assets_removed: usize,
    pub uploads_removed: usize,
    pub jobs_removed: usize,
    pub bytes_reclaimed: u64,
}

pub fn spawn(state: Arc<AppState>) {
    // Interval is overridable so the retention path can be tested without
    // waiting five minutes for a sweep.
    let interval = std::env::var("NMEDIA_SWEEP_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(SWEEP_INTERVAL);
    tokio::spawn(async move {
        // One sweep at startup (a crash can leave the cache over budget), then
        // on a timer.
        loop {
            // The sweep is pure std::fs over a tree that grows with the cache it
            // cleans; on a runtime worker it would stall request handling for the
            // length of the walk.
            let sweeping = state.clone();
            match tokio::task::spawn_blocking(move || sweep(&sweeping)).await {
                Ok(report) if report.assets_removed + report.uploads_removed + report.jobs_removed > 0 => {
                    tracing::info!(
                        assets = report.assets_removed,
                        uploads = report.uploads_removed,
                        jobs = report.jobs_removed,
                        mb = report.bytes_reclaimed / (1024 * 1024),
                        "retention sweep"
                    );
                }
                Ok(_) => {}
                Err(e) => tracing::error!(error = %e, "retention sweep task failed"),
            }
            tokio::time::sleep(interval).await;
        }
    });
}

pub fn sweep(state: &AppState) -> SweepReport {
    // The floor is a guard against a config typo, not a policy: a test can set 2s.
    let ttl = Duration::from_secs(state.config.ttl_seconds.max(1));
    let mut report = SweepReport {
        assets_removed: 0,
        uploads_removed: 0,
        jobs_removed: 0,
        bytes_reclaimed: 0,
    };

    // Assets: age first, then size, oldest first.
    let mut entries: Vec<(std::path::PathBuf, u64, SystemTime)> = Vec::new();
    if let Ok(dir) = std::fs::read_dir(state.assets.dir()) {
        for entry in dir.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "json").unwrap_or(false) {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                // An unreadable mtime is not "infinitely old": stamping the epoch
                // deletes a file that may have just been written.
                let Ok(modified) = meta.modified() else {
                    tracing::debug!(path = %path.display(), "retention: mtime unreadable, skipping");
                    continue;
                };
                entries.push((path, meta.len(), modified));
            }
        }
    }
    let now = SystemTime::now();
    for (path, size, modified) in &entries {
        let expired = now
            .duration_since(*modified)
            .map(|age| age > ttl)
            .unwrap_or(false);
        if expired && remove_asset(state, path) {
            report.assets_removed += 1;
            report.bytes_reclaimed += size;
        }
    }
    // The age pass already reclaimed some bytes; counting them again makes the
    // cache look over budget and evicts live files that fit.
    let mut total: u64 = entries
        .iter()
        .map(|(_, size, _)| *size)
        .sum::<u64>()
        .saturating_sub(report.bytes_reclaimed);
    if total > state.config.cache_max_bytes {
        let mut by_age = entries.clone();
        by_age.sort_by_key(|(_, _, modified)| *modified);
        for (path, size, _) in by_age {
            if total <= state.config.cache_max_bytes {
                break;
            }
            if remove_asset(state, &path) {
                total = total.saturating_sub(size);
                report.assets_removed += 1;
                report.bytes_reclaimed += size;
            }
        }
    }

    // Uploads: each upload is its own directory; the TTL lets a caller reuse a
    // fileId for a second operation before it disappears.
    if let Ok(dir) = std::fs::read_dir(&state.config.uploads_dir) {
        for entry in dir.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(modified) = meta.modified() else {
                tracing::debug!(path = %path.display(), "retention: mtime unreadable, skipping");
                continue;
            };
            let expired = now
                .duration_since(modified)
                .map(|age| age > ttl)
                .unwrap_or(false);
            if !expired {
                continue;
            }
            let size = directory_size(&path);
            if std::fs::remove_dir_all(&path).is_ok() {
                report.uploads_removed += 1;
                report.bytes_reclaimed += size;
            }
        }
    }

    // Job records: terminal jobs age out; a running one is never deleted.
    if let Ok(dir) = std::fs::read_dir(&state.config.jobs_dir) {
        for entry in dir.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e != "json").unwrap_or(true) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            // Age first: a running job keeps a recent mtime, so the body is only
            // read for the small expired subset instead of every record.
            let Ok(modified) = meta.modified() else {
                tracing::debug!(path = %path.display(), "retention: mtime unreadable, skipping");
                continue;
            };
            let expired = now
                .duration_since(modified)
                .map(|age| age > ttl)
                .unwrap_or(false);
            if !expired {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let terminal = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(str::to_string))
                .map(|status| {
                    matches!(
                        status.as_str(),
                        "completed" | "failed" | "cancelled" | "interrupted"
                    )
                })
                .unwrap_or(false);
            if terminal && std::fs::remove_file(&path).is_ok() {
                report.jobs_removed += 1;
            }
        }
    }

    report
}

/// Remove an asset file and its sidecar, by id derived from the file name.
fn remove_asset(state: &AppState, path: &std::path::Path) -> bool {
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
        return false;
    };
    state.assets.delete(stem).unwrap_or(false)
}

fn directory_size(path: &std::path::Path) -> u64 {
    let mut total = 0;
    if let Ok(dir) = std::fs::read_dir(path) {
        for entry in dir.flatten() {
            if let Ok(meta) = entry.metadata() {
                total += if meta.is_dir() {
                    directory_size(&entry.path())
                } else {
                    meta.len()
                };
            }
        }
    }
    total
}
