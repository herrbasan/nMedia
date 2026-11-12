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
        let chrome = crate::chromium::chrome_path();
        let mut engines = Self {
            ffmpeg,
            chrome,
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

fn version_line(binary: &PathBuf) -> Option<String> {
    let output = Command::new(binary).args(["-hide_banner", "-version"]).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().next().map(|line| line.trim().to_string())
}

fn lines(binary: &PathBuf, args: &[&str], skip: usize) -> Vec<String> {
    let output = Command::new(binary).args(args).output().ok();
    let text = output
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    text.lines()
        .skip(skip)
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// Encoder table rows look like ` V....D h264_nvenc  NVIDIA NVENC H.264 encoder (codec h264)`.
fn parse_encoders(binary: &PathBuf) -> Vec<Encoder> {
    let output = match Command::new(binary).args(["-hide_banner", "-encoders"]).output() {
        Ok(output) => output,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&output.stdout);
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
