//! Small shared helpers: ids, timestamps, mime/extension tables.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Opaque id for jobs and assets. Not cryptographic: a per-process random hash
/// seed plus a counter, which is enough to keep two requests apart and survives
/// no threat model. The Node service used `uuid()`; consumers treat ids as opaque.
pub fn id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(now_ms() as u64);
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u32(std::process::id());
    format!("{:016x}", hasher.finish())
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// RFC 3339 in UTC.
pub fn rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
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

pub fn rfc3339_now() -> String {
    rfc3339(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    )
}

pub fn mime_for_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "ico" => "image/x-icon",
        "tga" => "image/x-tga",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "opus" => "audio/opus",
        _ => "application/octet-stream",
    }
}

/// Output extension for a requested format, or `None` when this build cannot
/// write it. Refusing by name beats writing a PNG with a `.avif` name.
pub fn ext_for_format(format: &str) -> Option<&'static str> {
    match format.to_ascii_lowercase().as_str() {
        "png" => Some("png"),
        "jpeg" | "jpg" => Some("jpg"),
        "gif" => Some("gif"),
        "bmp" => Some("bmp"),
        "tiff" | "tif" => Some("tiff"),
        "ico" => Some("ico"),
        "tga" => Some("tga"),
        _ => None,
    }
}

pub fn ext_of(path: &std::path::Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Standard base64 (RFC 4648, with padding). Used for data: URIs into the
/// browser; a dependency for fifteen lines of table lookups is not worth it.
pub fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Standard base64 decode. Accepts padding, ignores whitespace, and rejects
/// anything that is not the standard alphabet — a caller that sends a data URI
/// tail with url-safe characters gets an error, not silent corruption.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u32> {
        Some(match byte {
            b'A'..=b'Z' => (byte - b'A') as u32,
            b'a'..=b'z' => (byte - b'a') as u32 + 26,
            b'0'..=b'9' => (byte - b'0') as u32 + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 3);
    let mut chunk = [0u32; 4];
    let mut filled = 0usize;
    let mut padding = 0usize;
    for byte in text.bytes() {
        if byte == b'\r' || byte == b'\n' || byte == b' ' || byte == b'\t' {
            continue;
        }
        if byte == b'=' {
            padding += 1;
            continue;
        }
        if padding > 0 {
            return None; // data after padding
        }
        chunk[filled] = value(byte)?;
        filled += 1;
        if filled == 4 {
            let n = (chunk[0] << 18) | (chunk[1] << 12) | (chunk[2] << 6) | chunk[3];
            out.push((n >> 16) as u8);
            out.push((n >> 8) as u8);
            out.push(n as u8);
            filled = 0;
        }
    }
    match filled {
        0 => {}
        1 => return None,
        2 => {
            if padding > 2 {
                return None;
            }
            let n = (chunk[0] << 18) | (chunk[1] << 12);
            out.push((n >> 16) as u8);
        }
        3 => {
            if padding > 1 {
                return None;
            }
            let n = (chunk[0] << 18) | (chunk[1] << 12) | (chunk[2] << 6);
            out.push((n >> 16) as u8);
            out.push((n >> 8) as u8);
        }
        _ => return None,
    }
    Some(out)
}

// ─── path allowlist ──────────────────────────────────────────────────────

/// `allowedInputPaths` / `allowedOutputPaths` from the Node config, kept as a
/// first-class rule. Comparison is canonical + component-wise: `/srv/media2`
/// must not pass for `/srv/media`, and a symlink that resolves outside the root
/// is refused rather than string-matched.
#[derive(Debug, Clone)]
pub struct PathList {
    pub all: bool,
    pub roots: Vec<PathBuf>,
}

impl PathList {
    /// Environment wins over `config.json`; absent both, everything is allowed —
    /// which is what the Node service defaulted to (`["*"]`).
    pub fn from_config_or_env(env_key: &str, config: Option<Vec<String>>) -> Self {
        if let Ok(raw) = std::env::var(env_key) {
            if !raw.trim().is_empty() {
                return Self::parse(Some(raw));
            }
        }
        match config {
            Some(list) => Self::parse(Some(list.join(";"))),
            None => Self::parse(None),
        }
    }

    /// `*` or empty = allow anything; otherwise a `;`-separated list of roots.
    pub fn parse(raw: Option<String>) -> Self {
        let Some(raw) = raw else {
            return Self { all: true, roots: Vec::new() };
        };
        let value = raw.trim();
        if value.is_empty() || value == "*" {
            return Self { all: true, roots: Vec::new() };
        }
        let roots: Vec<PathBuf> = value
            .split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect();
        Self { all: roots.is_empty(), roots }
    }

    pub fn check_existing(&self, path: &Path, what: &str) -> Result<PathBuf, String> {
        let canonical = std::fs::canonicalize(path)
            .map_err(|e| format!("{what} not accessible: {} ({e})", path.display()))?;
        self.assert_within(&canonical, what)?;
        Ok(canonical)
    }

    /// The file itself may not exist yet; the parent must, and must be allowed.
    pub fn check_for_write(&self, path: &Path, what: &str) -> Result<PathBuf, String> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| format!("{what} has no parent directory: {}", path.display()))?;
        let canonical_parent = std::fs::canonicalize(parent)
            .map_err(|e| format!("{what} parent not accessible: {} ({e})", parent.display()))?;
        self.assert_within(&canonical_parent, what)?;
        let name = path
            .file_name()
            .ok_or_else(|| format!("{what} has no file name: {}", path.display()))?;
        Ok(canonical_parent.join(name))
    }

    fn assert_within(&self, path: &Path, what: &str) -> Result<(), String> {
        if self.all {
            return Ok(());
        }
        for root in &self.roots {
            if let Ok(root) = std::fs::canonicalize(root) {
                if path.starts_with(&root) {
                    return Ok(());
                }
            }
        }
        Err(format!(
            "{what} is outside the allowed roots ({}) — set NMEDIA_ALLOWED_INPUT / NMEDIA_ALLOWED_OUTPUT or '*'",
            self.roots
                .iter()
                .map(|r| r.display().to_string())
                .collect::<Vec<_>>()
                .join("; ")
        ))
    }
}
