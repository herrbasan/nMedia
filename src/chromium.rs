//! Chromium as an engine: SVG rasterisation that is correct by construction.
//!
//! Why a browser for SVG: resvg implements the static SVG subset, and the parts
//! it lacks are exactly what a browser gives free -- CSS custom properties,
//! `@media (prefers-color-scheme)`, font-weight face matching, `textLength`
//! spacing. Chasing those in a subset renderer means rewriting CSS before parse.
//!
//! This drives a Chromium build through its command line
//! (`--screenshot`), which is enough for deterministic rasterisation. The engine
//! ships with the service — `runtime/` beside the binary, pinned by
//! `scripts/fetch-browser.ps1` — and a host's installed Chrome/Edge is only a
//! fallback, because rendering must not change when someone else's updater runs.
//! Interactive work (harvest, evaluate) needs CDP over a WebSocket; that arrives
//! with the browser tool, and this module is where its process handling lives.
//!
//! The engine may be a binary; the tool that drives it is ours.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A resolved browser: which executable answers, and what it is.
#[derive(Debug, Clone)]
pub struct Chrome {
    pub path: PathBuf,
    /// `configured` (env or config.json), `bundled` (shipped in `runtime/` beside
    /// the binary) or `system` (whatever the host happens to have installed).
    /// Published so a deployment can tell whether nMedia is driving its own
    /// engine or borrowing the machine's.
    pub source: &'static str,
    /// `chrome-headless-shell` is headless by construction: it implements none of
    /// the `--headless=` modes a full Chrome does, so it gets no flag at all.
    pub headless_shell: bool,
}

impl Chrome {
    /// The version line the binary prints, if it prints one. Chrome on Windows is
    /// a GUI-subsystem executable and can stay silent on a piped stdout — silence
    /// is reported as unknown rather than invented.
    pub fn version(&self) -> Option<String> {
        let output = Command::new(&self.path)
            .arg("--version")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let line = text.lines().next().unwrap_or("").trim().to_string();
        (!line.is_empty()).then_some(line)
    }
}

const EXE: &str = "chrome.exe";
const SHELL_EXE: &str = "chrome-headless-shell.exe";

/// Layouts a bundled engine may occupy, relative to a root. The Chrome for
/// Testing archive extracts to a version-named folder, so both shapes appear.
const BUNDLED_LAYOUTS: [&[&str]; 5] = [
    &["runtime", "chrome-headless-shell-win64"],
    &["runtime", "chrome-headless-shell"],
    &["runtime", "chrome-win64"],
    &["runtime", "chrome"],
    &["runtime"],
];

const SYSTEM_PATHS: [&str; 4] = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
];

fn candidate(path: PathBuf, source: &'static str) -> Option<Chrome> {
    if !path.is_file() {
        return None;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    Some(Chrome {
        headless_shell: name.contains("headless"),
        path,
        source,
    })
}

/// Any recognised binary inside `dir`, headless shell first.
fn in_dir(dir: &Path, source: &'static str) -> Option<Chrome> {
    for name in [SHELL_EXE, EXE] {
        if let Some(found) = candidate(dir.join(name), source) {
            return Some(found);
        }
    }
    None
}

fn exe_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.parent().map(Path::to_path_buf)
}

/// Resolution order: `NMEDIA_CHROME`, `NMEDIA_CHROME_DIR`, the engine shipped
/// beside the binary, then the host's Chrome/Edge, then PATH. The bundled engine
/// is deliberately ahead of the system one: a deployed nMedia must render with
/// the version it was built and tested against, not with whatever the machine
/// updated to last night.
pub fn resolve() -> Option<Chrome> {
    // Resolving walks five layouts, the system paths and every PATH entry with a
    // stat each. That is startup configuration, not per-render work.
    static RESOLVED: std::sync::OnceLock<Option<Chrome>> = std::sync::OnceLock::new();
    RESOLVED.get_or_init(resolve_once).clone()
}

fn resolve_once() -> Option<Chrome> {
    if let Ok(explicit) = std::env::var("NMEDIA_CHROME") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            if let Some(found) = candidate(PathBuf::from(trimmed), "configured") {
                return Some(found);
            }
        }
    }
    if let Ok(dir) = std::env::var("NMEDIA_CHROME_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            if let Some(found) = in_dir(Path::new(trimmed), "configured") {
                return Some(found);
            }
        }
    }

    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe_dir() {
        roots.push(dir);
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    for root in &roots {
        for layout in BUNDLED_LAYOUTS {
            let mut dir = root.clone();
            for part in layout {
                dir.push(part);
            }
            if let Some(found) = in_dir(&dir, "bundled") {
                return Some(found);
            }
        }
    }

    for path in SYSTEM_PATHS {
        if let Some(found) = candidate(PathBuf::from(path), "system") {
            return Some(found);
        }
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
        if let Some(found) = candidate(dir.join(EXE), "system") {
            return Some(found);
        }
    }
    None
}

pub fn chrome_path() -> Option<PathBuf> {
    resolve().map(|c| c.path)
}

pub struct Rendered {
    pub png: Vec<u8>,
}

/// Screenshot an HTML page at an exact viewport. Runs the browser as a child and
/// waits for the PNG to appear, with a hard timeout and a drained stderr pipe (an
/// unread pipe blocks the browser at the OS buffer size).
///
/// `transparent` asks the compositor for an alpha background
/// (`--default-background-color=00000000`), which is what makes an SVG round trip
/// through a browser keep its transparency.
pub fn screenshot_html(
    html: &str,
    width: u32,
    height: u32,
    work_dir: &Path,
    transparent: bool,
    timeout: Duration,
) -> Result<Rendered, String> {
    let chrome = resolve().ok_or_else(|| {
        "no browser engine: ship runtime/chrome-headless-shell (scripts/fetch-browser.ps1), \
         set NMEDIA_CHROME, or install Chrome/Edge"
            .to_string()
    })?;
    std::fs::create_dir_all(work_dir)
        .map_err(|e| format!("cannot create {}: {e}", work_dir.display()))?;

    let stamp = crate::util::id();
    let page = work_dir.join(format!("page-{stamp}.html"));
    let png = work_dir.join(format!("shot-{stamp}.png"));
    std::fs::write(&page, html).map_err(|e| format!("cannot write {}: {e}", page.display()))?;

    let profile = work_dir.join(format!("profile-{stamp}"));
    let mut args: Vec<String> = vec![
        "--disable-gpu".into(),
        "--hide-scrollbars".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--force-device-scale-factor=1".into(),
        "--disable-extensions".into(),
        format!("--user-data-dir={}", profile.display()),
        format!("--window-size={width},{height}"),
        format!("--screenshot={}", png.display()),
    ];
    if !chrome.headless_shell {
        args.push("--headless=new".into());
    }
    if transparent {
        args.push("--default-background-color=00000000".into());
    }
    args.push(file_uri(&page));

    let mut child = match Command::new(&chrome.path)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            // The page file already exists; a deployment that cannot spawn would
            // otherwise leave one orphan per attempt.
            let _ = std::fs::remove_file(&page);
            return Err(format!("cannot spawn {}: {e}", chrome.path.display()));
        }
    };

    // Drain stderr on its own thread so the browser can never block on a full pipe.
    let stderr = child.stderr.take();
    let drain = std::thread::spawn(move || {
        let mut tail = Vec::new();
        if let Some(mut pipe) = stderr {
            let mut chunk = [0u8; 4096];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        tail.extend_from_slice(&chunk[..n]);
                        if tail.len() > 32 * 1024 {
                            let excess = tail.len() - 32 * 1024;
                            tail.drain(..excess);
                        }
                    }
                }
            }
        }
        String::from_utf8_lossy(&tail).trim().to_string()
    });

    let deadline = Instant::now() + timeout;
    let mut killed = false;
    let exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    kill_tree(&mut child);
                    killed = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                // Every other exit arm cleans up; this one used to leak the whole
                // profile directory plus the failed page and screenshot.
                let _ = std::fs::remove_file(&page);
                let _ = std::fs::remove_file(&png);
                let _ = std::fs::remove_dir_all(&profile);
                return Err(format!("chromium process error: {e}"));
            }
        }
    };
    let detail = drain.join().unwrap_or_default();
    let _ = std::fs::remove_file(&page);
    let _ = std::fs::remove_dir_all(&profile);

    if killed {
        let _ = std::fs::remove_file(&png);
        return Err(format!("chromium exceeded {} s and was killed", timeout.as_secs()));
    }
    if let Some(status) = exit {
        if !status.success() {
            let _ = std::fs::remove_file(&png);
            return Err(format!(
                "chromium exited with {} — {}",
                status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into()),
                if detail.is_empty() { "no diagnostics".to_string() } else { detail }
            ));
        }
    }

    let bytes = std::fs::read(&png)
        .map_err(|e| format!("chromium produced no screenshot at {}: {e}", png.display()))?;
    let _ = std::fs::remove_file(&png);
    if bytes.len() < 8 || &bytes[1..4] != b"PNG" {
        return Err("chromium wrote something that is not a PNG".to_string());
    }
    Ok(Rendered { png: bytes })
}

/// A page whose only content is the SVG, sized exactly to the viewport so the
/// screenshot is the drawing and nothing else. The SVG travels inline as a data
/// URI — no file:// cross-origin question, nothing to clean up.
pub fn svg_page(svg: &[u8], width: u32, height: u32, background: &str) -> String {
    let encoded = crate::util::base64_encode(svg);
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <style>html,body{{margin:0;padding:0;background:{background};overflow:hidden}}\
         img{{display:block;width:{width}px;height:{height}px}}</style></head>\
         <body><img src=\"data:image/svg+xml;base64,{encoded}\"></body></html>"
    )
}

pub fn file_uri(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file:///");
    for byte in text.trim_start_matches('/').bytes() {
        match byte {
            // Path separators and the drive colon stay literal; everything else
            // outside the unreserved set is escaped, or '#' turns the rest of the
            // path into a fragment and a space makes Chromium load nothing.
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b':' | b'-' | b'_' | b'.' | b'~'
            | b'+' | b'@' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Killing the browser alone leaves its renderer/GPU/crashpad children holding the
/// stderr pipe and the profile directory, so the timeout would stop bounding time.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_with_spaces_and_hashes_survives_the_uri() {
        // Unescaped, '#' truncates the path into a fragment and the space makes
        // Chromium render nothing.
        assert_eq!(
            file_uri(Path::new("C:\\work\\a b#c\\page.html")),
            "file:///C:/work/a%20b%23c/page.html"
        );
        assert_eq!(file_uri(Path::new("/tmp/plain.png")), "file:///tmp/plain.png");
    }
}
