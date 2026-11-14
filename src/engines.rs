//! Engine introspection, probed once at startup.
//!
//! The Node service exposed ffmpeg's codecs, filters and hwaccels through
//! `/v1/capabilities`; that was the only honest way for a caller to know whether
//! a hardware path existed. This keeps that: the answers come from the binary we
//! are actually going to run, not from a list we maintain by hand and forget.

use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, Default)]
pub struct Engines {
    pub ffmpeg: Option<PathBuf>,
    pub ffmpeg_version: Option<String>,
    pub chrome: Option<PathBuf>,
    /// `configured` | `bundled` | `system` — where the browser came from.
    pub chrome_source: Option<&'static str>,
    pub chrome_version: Option<String>,
    pub hwaccels: Vec<String>,
    /// Encoder name -> the codec it encodes, e.g. `h264_nvenc` -> `h264`.
    pub encoders: Vec<Encoder>,
    pub filter_count: usize,
}

#[derive(Debug, Clone)]
pub struct Encoder {
    pub name: String,
    pub codec: String,
    pub hardware: bool,
}

impl Engines {
    pub fn probe() -> Self {
        let ffmpeg = crate::ffmpeg::ffmpeg_path();
        let browser = crate::chromium::resolve();
        let mut engines = Self {
            ffmpeg,
            chrome: browser.as_ref().map(|b| b.path.clone()),
            chrome_source: browser.as_ref().map(|b| b.source),
            chrome_version: browser.as_ref().and_then(|b| b.version()),
            ..Self::default()
        };
        let Some(ref binary) = engines.ffmpeg else {
            return engines;
        };
        engines.ffmpeg_version = version_line(binary);
        engines.hwaccels = lines(binary, &["-hwaccels"], 1);
        engines.encoders = parse_encoders(binary);
        engines.filter_count = lines(binary, &["-filters"], 1).len();
        engines
    }

    pub fn hardware_encoders(&self) -> Vec<&Encoder> {
        self.encoders.iter().filter(|e| e.hardware).collect()
    }

    /// Encoders for one codec, hardware first — a caller asking "can I do h264?"
    /// should meet `h264_nvenc` before `libx264`.
    pub fn encoders_for(&self, codec: &str) -> Vec<&Encoder> {
        let mut list: Vec<&Encoder> = self.encoders.iter().filter(|e| e.codec == codec).collect();
        list.sort_by_key(|e| !e.hardware);
        list
    }
}

/// The engine was resolved but cannot run (not executable, wrong arch, broken
/// wrapper). That is not the same as "this ffmpeg lacks the feature", and an empty
/// capability list would read as the latter — so the failure is named.
fn probe_output(binary: &PathBuf, args: &[&str]) -> Option<String> {
    match Command::new(binary).args(args).output() {
        Ok(output) if output.status.success() => Some(String::from_utf8_lossy(&output.stdout).to_string()),
        Ok(output) => {
            tracing::warn!(
                binary = %binary.display(),
                args = ?args,
                status = %output.status,
                "engine probe exited with a failure status; reporting no capability"
            );
            None
        }
        Err(e) => {
            tracing::warn!(
                binary = %binary.display(),
                args = ?args,
                error = %e,
                "engine probe could not run; reporting no capability"
            );
            None
        }
    }
}

fn version_line(binary: &PathBuf) -> Option<String> {
    let text = probe_output(binary, &["-hide_banner", "-version"])?;
    text.lines().next().map(|line| line.trim().to_string())
}

fn lines(binary: &PathBuf, args: &[&str], skip: usize) -> Vec<String> {
    let text = probe_output(binary, args).unwrap_or_default();
    text.lines()
        .skip(skip)
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// Encoder table rows look like ` V....D h264_nvenc  NVIDIA NVENC H.264 encoder (codec h264)`.
fn parse_encoders(binary: &PathBuf) -> Vec<Encoder> {
    let Some(text) = probe_output(binary, &["-hide_banner", "-encoders"]) else {
        return Vec::new();
    };
    let mut encoders = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('V') && !trimmed.starts_with('A') && !trimmed.starts_with('S') {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let Some(_flags) = parts.next() else { continue };
        let Some(name) = parts.next() else { continue };
        let rest: String = parts.collect::<Vec<_>>().join(" ");
        let Some(codec) = rest
            .rsplit_once("(codec ")
            .and_then(|(_, tail)| tail.trim_end_matches(')').split(' ').next())
            .map(|s| s.to_string())
        else {
            continue;
        };
        let hardware = name.contains("nvenc")
            || name.contains("qsv")
            || name.contains("amf")
            || name.contains("vaapi")
            || name.contains("videotoolbox")
            || name.contains("mf");
        encoders.push(Encoder { name: name.to_string(), codec, hardware });
    }
    encoders
}
