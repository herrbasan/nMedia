//! Logging, to the convention in `documentation/The Project/infra_nlogger.md`.
//!
//! `nLogger` is the reference implementation, not a dependency. Any service in the
//! ecosystem writes the same files so nPM's log viewer, a `tail` and a `grep` work
//! across the stack:
//!
//! - `logs/main-0.log` — JSONL, current; rolls at 10 MB into `main-1.log` …
//!   `main-9.log`, higher number = older
//! - `logs/<session>.log` — human lines for this process run, `session` being
//!   `<prefix>-<6 lowercase alnum>`, generated once at startup
//! - every line carries `ts`, `level`, `type`, `msg`, `meta`, `session`
//!
//! Files are opened per line rather than held open: a handle kept open leaves the
//! directory entry at size 0 on Windows, and a log viewer that stat()s the file
//! would show an empty log next to a working tail. The volume here is a few lines
//! per request, so the extra open costs nothing worth counting.
//!
//! Stdout keeps its tracing output as before: nPM captures it, so a service is
//! readable without the files and greppable with them.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_FILES: usize = 10;

pub struct JsonFileLayer {
    state: Mutex<Writer>,
    session: String,
    minimum: u8,
}

struct Writer {
    dir: PathBuf,
    prefix: String,
    main_bytes: u64,
}

pub fn init(prefix: &str, dir: &Path, minimum: Level, retention_days: u64) -> anyhow::Result<()> {
    fs::create_dir_all(dir)
        .map_err(|e| anyhow::anyhow!("cannot create log directory {}: {e}", dir.display()))?;
    prune_session_logs(dir, prefix, retention_days);

    let session = format!("{prefix}-{}", short_id());
    let layer = JsonFileLayer {
        state: Mutex::new(Writer {
            dir: dir.to_path_buf(),
            prefix: prefix.to_string(),
            main_bytes: fs::metadata(dir.join("main-0.log"))
                .map(|m| m.len())
                .unwrap_or(0),
        }),
        session: session.clone(),
        minimum: level_rank(minimum),
    };

    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_target(true)
                .with_writer(std::io::stdout),
        )
        .with(layer)
        .try_init()
        .map_err(|e| anyhow::anyhow!("cannot install the log subscriber: {e}"))?;

    tracing::info!(session = %session, dir = %dir.display(), "logging started");
    Ok(())
}

pub fn level_rank(level: Level) -> u8 {
    match level {
        Level::TRACE | Level::DEBUG => 0,
        Level::INFO => 1,
        Level::WARN => 2,
        Level::ERROR => 3,
    }
}

impl JsonFileLayer {
    fn write_line(&self, level: &Level, target: &str, fields: &Fields) {
        if level_rank(*level) < self.minimum {
            return;
        }
        let Ok(mut writer) = self.state.lock() else {
            return;
        };
        let timestamp = rfc3339_millis();
        let message = fields.message.clone().unwrap_or_default();
        let category = target.rsplit("::").next().unwrap_or(target).to_string();
        let meta = if fields.meta.is_empty() {
            None
        } else {
            Some(Value::Object(fields.meta.clone()))
        };

        let mut entry = Map::new();
        entry.insert("ts".into(), Value::String(timestamp.clone()));
        entry.insert("level".into(), Value::String(level.to_string()));
        entry.insert("type".into(), Value::String(category.clone()));
        entry.insert("msg".into(), Value::String(message.clone()));
        if let Some(meta) = meta.clone() {
            entry.insert("meta".into(), meta);
        }
        entry.insert("session".into(), Value::String(self.session.clone()));

        let mut line = serde_json::to_string(&Value::Object(entry)).unwrap_or_default();
        if line.len() as u64 + 1 > MAX_FILE_BYTES {
            // Never drop a line: truncate it, and say so. The cut is walked back
            // to a char boundary because `truncate` panics mid-character.
            let mut cut = (MAX_FILE_BYTES / 2) as usize;
            while cut > 0 && !line.is_char_boundary(cut) {
                cut -= 1;
            }
            line.truncate(cut);
            line.push_str("...[TRUNCATED]");
        }
        line.push('\n');
        let bytes = line.len() as u64;

        let main_path = writer.dir.join("main-0.log");
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&main_path) {
            // Count only what reached the file, or a failed write rotates away
            // real history to make room for bytes that were never there.
            if file.write_all(line.as_bytes()).and_then(|()| file.flush()).is_ok() {
                writer.main_bytes += bytes;
            }
        }

        let meta_text = match &meta {
            Some(value) => format!(" {}", serde_json::to_string(value).unwrap_or_default()),
            None => String::new(),
        };
        let session_path = writer.dir.join(format!("{}.log", self.session));
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&session_path) {
            let _ = writeln!(file, "[{timestamp}] [{level}] [{category}] {message}{meta_text}");
            let _ = file.flush();
        }

        if writer.main_bytes >= MAX_FILE_BYTES {
            rotate(&mut writer);
        }
    }
}

/// `main-0.log` is current; roll it down and drop the oldest.
fn rotate(writer: &mut Writer) {
    let dir = &writer.dir;
    let oldest = dir.join(format!("main-{}.log", MAX_FILES - 1));
    let _ = fs::remove_file(&oldest);
    for index in (1..MAX_FILES - 1).rev() {
        let from = dir.join(format!("main-{index}.log"));
        let to = dir.join(format!("main-{}.log", index + 1));
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }
    // Reset only when the roll happened; otherwise the counter keeps the file
    // over the cap and the next line retries instead of growing unbounded.
    if fs::rename(dir.join("main-0.log"), dir.join("main-1.log")).is_ok() {
        writer.main_bytes = 0;
    }
}

impl<S: Subscriber> Layer<S> for JsonFileLayer {
    fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
        let mut fields = Fields::default();
        event.record(&mut fields);
        let metadata = event.metadata();
        self.write_line(metadata.level(), metadata.target(), &fields);
    }
}

#[derive(Default)]
struct Fields {
    message: Option<String>,
    meta: Map<String, Value>,
}

impl Fields {
    fn record(&mut self, field: &Field, value: Value) {
        if field.name() == "message" {
            self.message = Some(match value {
                Value::String(s) => s,
                other => other.to_string(),
            });
        } else {
            self.meta.insert(field.name().to_string(), value);
        }
    }
}

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.record(field, Value::String(value.to_string()));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.record(field, Value::Bool(value));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.record(field, Value::from(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.record(field, Value::from(value));
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.record(field, Value::from(value));
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.record(field, Value::String(format!("{value:?}")));
    }
}

/// Drop `<prefix>-*.log` files older than the retention window.
fn prune_session_logs(dir: &Path, prefix: &str, retention_days: u64) {
    let cutoff = SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(retention_days.max(1) * 86_400));
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(&format!("{prefix}-")) || !name.ends_with(".log") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else { continue };
        let Ok(modified) = metadata.modified() else { continue };
        if let Some(cutoff) = cutoff {
            if modified < cutoff {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// RFC 3339 in UTC with milliseconds, as the convention requires.
pub fn rfc3339_millis() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let millis = now.as_millis() as u64;
    let secs = millis / 1000;
    let frac = millis % 1000;
    format!("{}.{frac:03}Z", crate::util::rfc3339(secs).trim_end_matches('Z'))
}

fn short_id() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1)
        ^ ((std::process::id() as u64) << 32);
    let mut value = seed;
    let mut out = String::with_capacity(6);
    for _ in 0..6 {
        out.push(ALPHABET[(value % ALPHABET.len() as u64) as usize] as char);
        value /= ALPHABET.len() as u64;
    }
    out
}
