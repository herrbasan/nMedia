//! Chromium as an engine: SVG rasterisation that is correct by construction.
//!
//! Why a browser for SVG: resvg implements the static SVG subset, and the parts
//! it lacks are exactly what a browser gives free -- CSS custom properties,
//! `@media (prefers-color-scheme)`, font-weight face matching, `textLength`
//! spacing. Chasing those in a subset renderer means rewriting CSS before parse.
//!
//! This drives the installed Chrome/Edge through its command line
//! (`--headless=new --screenshot`), which is enough for deterministic
//! rasterisation. Interactive work (harvest, evaluate) needs CDP over a
//! WebSocket; that arrives with the browser tool in the backend plan, and this
//! module is where its process handling lives.
//!
//! The engine may be a binary; the tool that drives it is ours.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// `NMEDIA_CHROME` wins, then the usual install locations, then PATH.
pub fn chrome_path() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("NMEDIA_CHROME") {
        if !explicit.trim().is_empty() {
            let p = PathBuf::from(explicit);
            return p.is_file().then_some(p);
        }
    }
    let candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ];
    for candidate in candidates {
        let p = PathBuf::from(candidate);
        if p.is_file() {
            return Some(p);
        }
    }
    let exe = format!("chrome{}", std::env::consts::EXE_SUFFIX);
    for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
        let candidate = dir.join(&exe);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
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
    let chrome = chrome_path()
        .ok_or_else(|| "no Chromium found: set NMEDIA_CHROME or install Chrome/Edge".to_string())?;
    std::fs::create_dir_all(work_dir)
        .map_err(|e| format!("cannot create {}: {e}", work_dir.display()))?;

    let stamp = crate::util::id();
    let page = work_dir.join(format!("page-{stamp}.html"));
    let png = work_dir.join(format!("shot-{stamp}.png"));
    std::fs::write(&page, html).map_err(|e| format!("cannot write {}: {e}", page.display()))?;

    let profile = work_dir.join(format!("profile-{stamp}"));
    let mut args: Vec<String> = vec![
        "--headless=new".into(),
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
    if transparent {
        args.push("--default-background-color=00000000".into());
    }
    args.push(file_uri(&page));

    let mut child = Command::new(&chrome)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot spawn {}: {e}", chrome.display()))?;

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
                    let _ = child.kill();
                    let _ = child.wait();
                    killed = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = std::fs::remove_file(&page);
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
    format!("file:///{}", text.trim_start_matches('/'))
}
