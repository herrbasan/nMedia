//! Audio and video, driven through ffmpeg as a child process.
//!
//! The engine rule from concept §8.1: ffmpeg is an engine, the tool that drives
//! it is ours. Arguments are built as argv arrays — never a shell string — with
//! `-nostdin`, `-y`, a wall-clock timeout, and a cancellation path that kills the
//! child and waits for it. stderr is captured and reported, because "ffmpeg
//! failed" without its reason is the kind of error that costs an afternoon.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use tokio::process::Command;
use tokio::sync::Notify;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AudioOptions {
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub format: Option<String>,
    pub audio_bitrate: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VideoOptions {
    pub mode: Option<String>,
    pub fps: Option<f64>,
    pub format: Option<String>,
    pub max_dimension: Option<u32>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub hwaccel: Option<String>,
    pub cli_command: Option<String>,
    pub audio_bitrate: Option<String>,
}

/// `NMEDIA_FFMPEG` wins, then the first `ffmpeg` on PATH. Returns `None` so the
/// caller can report an unavailable processor instead of failing at job time.
pub fn ffmpeg_path() -> Option<PathBuf> {
    configured("NMEDIA_FFMPEG").or_else(|| which("ffmpeg"))
}

pub fn ffprobe_path() -> Option<PathBuf> {
    configured("NMEDIA_FFPROBE").or_else(|| which("ffprobe"))
}

/// A pinned binary is authoritative, so a rejected override is named rather than
/// silently swapped for whatever PATH happens to hold.
fn configured(var: &str) -> Option<PathBuf> {
    let Ok(explicit) = std::env::var(var) else { return None };
    let trimmed = explicit.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_file() {
        return Some(path);
    }
    tracing::warn!(
        variable = var,
        path = %path.display(),
        "configured binary is not a file; falling back to PATH"
    );
    None
}

fn which(name: &str) -> Option<PathBuf> {
    let exe = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
        let candidate = dir.join(&exe);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Tracking is an RAII pair, not a manual call at each exit: a future dropped at
/// an await (aborted request, select branch) would otherwise leave a dead pid in
/// the registry, and a recycled pid is what `kill_all_children` would then kill.
struct Tracked(Option<u32>);

impl Drop for Tracked {
    fn drop(&mut self) {
        untrack(self.0);
    }
}

/// Live child pids, so a graceful shutdown can stop work instead of leaving an
/// orphaned transcode running after the service is gone. A hard kill still
/// orphans children — that needs a Windows Job Object, which is not in this
/// build; the startup sweep in `main` is why it stays a nuisance, not a leak.
static CHILDREN: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());

// A poisoned lock cannot corrupt a Vec<u32>, and losing the registry would mean
// orphaned transcodes, so the guard is recovered rather than dropped.
fn track(pid: Option<u32>) {
    if let Some(pid) = pid {
        CHILDREN.lock().unwrap_or_else(|e| e.into_inner()).push(pid);
    }
}

fn untrack(pid: Option<u32>) {
    if let Some(pid) = pid {
        CHILDREN
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|p| *p != pid);
    }
}

/// Kill every child still running. Called on shutdown, after admission stops.
pub fn kill_all_children() -> usize {
    let pids: Vec<u32> = CHILDREN.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut killed = 0;
    for pid in pids {
        let status = if cfg!(windows) {
            std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
        } else {
            std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
        };
        if status.map(|s| s.success()).unwrap_or(false) {
            killed += 1;
        }
    }
    killed
}

/// Audio codec for an output container. Refusing an unknown format beats writing
/// a file that no player recognises.
fn audio_codec(format: &str) -> Result<&'static str, String> {
    Ok(match format {
        "mp3" => "libmp3lame",
        "wav" => "pcm_s16le",
        "ogg" => "libvorbis",
        "m4a" | "aac" => "aac",
        "flac" => "flac",
        "opus" => "libopus",
        other => {
            return Err(format!(
                "unsupported audio format '{other}' — mp3, wav, ogg, m4a, aac, flac, opus"
            ))
        }
    })
}

pub fn validate_audio_format(format: &str) -> Result<(), String> {
    audio_codec(format).map(|_| ())
}

pub fn validate_video_format(format: &str) -> Result<(), String> {
    match format {
        "mp4" | "webm" | "mkv" => Ok(()),
        other => Err(format!("unsupported video format '{other}' — mp4, webm, mkv")),
    }
}

pub fn default_ext(format: &str) -> &'static str {
    match format {
        "mp3" => "mp3",
        "wav" => "wav",
        "ogg" => "ogg",
        "m4a" => "m4a",
        "aac" => "aac",
        "flac" => "flac",
        "opus" => "opus",
        "mp4" => "mp4",
        "webm" => "webm",
        "mkv" => "mkv",
        _ => "bin",
    }
}

pub async fn transcode_audio(
    input: &Path,
    output: &Path,
    opts: &AudioOptions,
    cancel: &Notify,
) -> Result<(), String> {
    let format = opts.format.clone().unwrap_or_else(|| "mp3".into());
    let codec = audio_codec(&format)?;
    let mut args = base_args(input);
    if let Some(rate) = opts.sample_rate {
        args.push("-ar".into());
        args.push(rate.to_string());
    }
    if let Some(channels) = opts.channels {
        args.push("-ac".into());
        args.push(channels.to_string());
    }
    args.push("-c:a".into());
    args.push(codec.into());
    if let Some(bitrate) = &opts.audio_bitrate {
        args.push("-b:a".into());
        args.push(bitrate.clone());
    }
    args.push(output.to_string_lossy().to_string());
    run(&args, cancel, Duration::from_secs(900)).await
}

pub async fn extract_audio(
    input: &Path,
    output: &Path,
    opts: &AudioOptions,
    cancel: &Notify,
) -> Result<(), String> {
    let mut args = base_args(input);
    let format = opts.format.clone().unwrap_or_else(|| "mp3".into());
    args.push("-vn".into());
    args.push("-c:a".into());
    args.push(audio_codec(&format)?.into());
    if let Some(bitrate) = &opts.audio_bitrate {
        args.push("-b:a".into());
        args.push(bitrate.clone());
    }
    args.push(output.to_string_lossy().to_string());
    run(&args, cancel, Duration::from_secs(900)).await
}

pub async fn transcode_video(
    input: &Path,
    output: &Path,
    opts: &VideoOptions,
    cancel: &Notify,
) -> Result<(), String> {
    let mut args = base_args(input);
    if let Some(hwaccel) = &opts.hwaccel {
        args.push("-hwaccel".into());
        args.push(hwaccel.clone());
    }
    let codec = opts.video_codec.clone().unwrap_or_else(|| "libx264".into());
    args.push("-c:v".into());
    args.push(codec);
    if let Some(max) = opts.max_dimension {
        args.push("-vf".into());
        args.push(format!("scale='min({max},iw)':-2"));
    }
    if let Some(fps) = opts.fps {
        args.push("-r".into());
        args.push(fps.to_string());
    }
    args.push("-c:a".into());
    args.push(opts.audio_codec.clone().unwrap_or_else(|| "aac".into()));
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push(output.to_string_lossy().to_string());
    run(&args, cancel, Duration::from_secs(3600)).await
}

/// Frames land in `dir` as `frame-0001.jpg`; the count is what the caller reports.
pub async fn extract_keyframes(
    input: &Path,
    dir: &Path,
    fps: f64,
    cancel: &Notify,
) -> Result<usize, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    // ffmpeg overwrites frame-0001..N but never deletes the tail of a longer
    // earlier run, so a reused directory would report frames it did not write.
    for entry in std::fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))? {
        let stale = entry
            .map_err(|e| format!("cannot read {}: {e}", dir.display()))?
            .path();
        if stale.extension().map(|ext| ext == "jpg").unwrap_or(false) {
            std::fs::remove_file(&stale)
                .map_err(|e| format!("cannot clear {}: {e}", stale.display()))?;
        }
    }
    let mut args = base_args(input);
    args.push("-vf".into());
    args.push(format!("fps={fps}"));
    args.push(dir.join("frame-%04d.jpg").to_string_lossy().to_string());
    run(&args, cancel, Duration::from_secs(1800)).await?;
    let count = std::fs::read_dir(dir)
        .map_err(|e| format!("cannot read {}: {e}", dir.display()))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().map(|ext| ext == "jpg").unwrap_or(false))
        .count();
    if count == 0 {
        return Err("ffmpeg produced no keyframes — check the input duration and fps".into());
    }
    Ok(count)
}

fn base_args(input: &Path) -> Vec<String> {
    vec![
        "-nostdin".into(),
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-i".into(),
        input.to_string_lossy().to_string(),
    ]
}

async fn run(args: &[String], cancel: &Notify, timeout: Duration) -> Result<(), String> {
    let program = ffmpeg_path().ok_or_else(|| {
        "ffmpeg not found: set NMEDIA_FFMPEG or put ffmpeg on PATH".to_string()
    })?;
    let mut command = Command::new(&program);
    command
        .args(args)
        .stdin(Stdio::null())
        // ffmpeg writes media to the file, not to stdout: a piped-and-unread
        // stdout is a latent deadlock, so it is discarded outright.
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Registered before the child exists: a cancel issued between spawn and the
    // first poll of the select would otherwise be lost, and the transcode would
    // run to its full timeout instead of stopping.
    let cancelled = cancel.notified();
    tokio::pin!(cancelled);
    cancelled.as_mut().enable();

    let mut child = command
        .spawn()
        .map_err(|e| format!("cannot spawn {}: {e}", program.display()))?;
    let pid = child.id();
    track(pid);
    let _tracked = Tracked(pid);

    // Drain stderr *while* the process runs: an undrained pipe blocks ffmpeg at
    // the OS buffer size, and reading only after failure would deadlock before
    // the failure is observable. Keep a bounded tail for the error message.
    let stderr = child.stderr.take();
    let drain = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        const KEEP: usize = 64 * 1024;
        let mut tail: Vec<u8> = Vec::new();
        if let Some(mut pipe) = stderr {
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        tail.extend_from_slice(&chunk[..n]);
                        if tail.len() > KEEP {
                            let excess = tail.len() - KEEP;
                            tail.drain(..excess);
                        }
                    }
                }
            }
        }
        String::from_utf8_lossy(&tail).trim().to_string()
    });

    let outcome = tokio::select! {
        status = child.wait() => status.map(|s| s.success()),
        _ = &mut cancelled => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = drain.await;
            return Err("cancelled".to_string());
        }
        _ = tokio::time::sleep(timeout) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = drain.await;
            return Err(format!("ffmpeg exceeded {} s and was killed", timeout.as_secs()));
        }
    };
    let detail = drain.await.unwrap_or_default();

    match outcome {
        Ok(true) => Ok(()),
        Ok(false) => Err(if detail.is_empty() {
            "ffmpeg exited with a failure status and said nothing".to_string()
        } else {
            format!("ffmpeg failed: {detail}")
        }),
        Err(e) => Err(format!("ffmpeg process error: {e}")),
    }
}

// ─── still-image decode (HEIC/HEIF) ──────────────────────────────────────

/// True for a HEIF-family container (iPhone HEIC included): an ISO-BMFF `ftyp`
/// box whose major brand is one of the HEIF/HEVC brands.
pub fn is_heif(bytes: &[u8]) -> bool {
    if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let brand = &bytes[8..12];
    matches!(
        brand,
        b"heic" | b"heix" | b"heim" | b"heis" | b"hevc" | b"hevx" | b"mif1" | b"msf1"
    )
}

/// Decode one still image to raw RGB through ffmpeg.
///
/// PPM, not PNG: the purpose is pixels, and a PPM header is nine bytes of ASCII
/// with no codec to run. Measured on a 12 MP iPhone HEIC: 182 ms to a finished
/// JPEG directly, so the pipeline should not spend another 600 ms PNG-round
/// tripping.
pub async fn decode_image_rgb(
    input: &Path,
    cancel: &Notify,
) -> Result<(Vec<u8>, u32, u32), String> {
    let program = ffmpeg_path().ok_or_else(|| {
        "ffmpeg not found: set NMEDIA_FFMPEG or put ffmpeg on PATH (needed for HEIC/HEIF)".to_string()
    })?;
    let cancelled = cancel.notified();
    tokio::pin!(cancelled);
    cancelled.as_mut().enable();

    let mut child = Command::new(&program)
        .args([
            "-nostdin".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-i".to_string(),
            input.to_string_lossy().to_string(),
            "-frames:v".to_string(),
            "1".to_string(),
            "-f".to_string(),
            "image2pipe".to_string(),
            "-vcodec".to_string(),
            "ppm".to_string(),
            "-".to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot spawn {}: {e}", program.display()))?;

    let pid = child.id();
    track(pid);
    let _tracked = Tracked(pid);
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        // A still image may declare any dimensions, and ffmpeg honours them: an
        // unbounded read is a single-request OOM for the whole process.
        const MAX_PPM: u64 = 256 * 1024 * 1024;
        let mut buffer = Vec::new();
        if let Some(pipe) = stdout.as_mut() {
            let _ = pipe.take(MAX_PPM).read_to_end(&mut buffer).await;
        }
        buffer
    });
    let stderr_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut tail = Vec::new();
        if let Some(pipe) = stderr.as_mut() {
            let _ = pipe.read_to_end(&mut tail).await;
        }
        String::from_utf8_lossy(&tail).trim().to_string()
    });

    let status = tokio::select! {
        result = child.wait() => result.map_err(|e| format!("ffmpeg process error: {e}"))?,
        _ = &mut cancelled => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err("cancelled".to_string());
        }
        // Without this arm a stalled decode (corrupt frame, blocked pipe) never
        // reaches an exit and the request lives until the process restarts.
        () = tokio::time::sleep(Duration::from_secs(60)) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err("ffmpeg image decode exceeded 60 s and was killed".to_string());
        }
    };
    let data = stdout_task.await.unwrap_or_default();
    let detail = stderr_task.await.unwrap_or_default();

    if !status.success() {
        return Err(format!(
            "ffmpeg could not decode {}: {}",
            input.display(),
            if detail.is_empty() { "no diagnostics".to_string() } else { detail }
        ));
    }
    parse_ppm(&data)
}

/// Minimal binary PPM (P6) reader: magic, width, height, maxval, then RGB bytes.
fn parse_ppm(data: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let mut fields = Vec::new();
    let mut index = 0usize;
    while fields.len() < 4 {
        while index < data.len() && (data[index] as char).is_ascii_whitespace() {
            index += 1;
        }
        if index < data.len() && data[index] == b'#' {
            while index < data.len() && data[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        let start = index;
        while index < data.len() && !(data[index] as char).is_ascii_whitespace() {
            index += 1;
        }
        if start == index {
            return Err("ffmpeg produced no PPM data".to_string());
        }
        fields.push(String::from_utf8_lossy(&data[start..index]).to_string());
    }
    // One whitespace byte separates the header from the pixel data.
    index += 1;
    if fields[0] != "P6" {
        return Err(format!("expected a P6 PPM, got '{}'", fields[0]));
    }
    let width: u32 = fields[1].parse().map_err(|_| format!("bad PPM width '{}'", fields[1]))?;
    let height: u32 = fields[2].parse().map_err(|_| format!("bad PPM height '{}'", fields[2]))?;
    let maxval: u32 = fields[3].parse().map_err(|_| format!("bad PPM maxval '{}'", fields[3]))?;
    if maxval != 255 {
        return Err(format!("expected 8-bit PPM, got maxval {maxval}"));
    }
    let expected = width as usize * height as usize * 3;
    if data.len() < index + expected {
        return Err(format!(
            "PPM truncated: expected {expected} bytes, got {}",
            data.len().saturating_sub(index)
        ));
    }
    Ok((data[index..index + expected].to_vec(), width, height))
}

/// `ffprobe -print_format json` — the shape `/v1/info` and the probes report.
pub async fn probe(path: &Path) -> Result<serde_json::Value, String> {
    let program = ffprobe_path().ok_or_else(|| {
        "ffprobe not found: set NMEDIA_FFPROBE or put ffprobe on PATH".to_string()
    })?;
    let child = Command::new(&program)
        .args([
            "-v".to_string(),
            "error".to_string(),
            "-print_format".to_string(),
            "json".to_string(),
            "-show_format".to_string(),
            "-show_streams".to_string(),
            path.to_string_lossy().to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot run ffprobe: {e}"))?;
    // A pipe, a stalled mount or a half-written container blocks forever; the
    // same budget `run` uses is what keeps the request (and the pid) bounded.
    let pid = child.id();
    track(pid);
    let output = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output()).await;
    untrack(pid);
    let output = output
        .map_err(|_| "ffprobe exceeded 60 s and was killed".to_string())?
        .map_err(|e| format!("ffprobe process error: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("ffprobe returned unreadable JSON: {e}"))
}
