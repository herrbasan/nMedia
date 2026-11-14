//! Asset cache: `<cache>/assets/<id>.<ext>` plus `<id>.json` beside it.
//!
//! Files on disk are the record; the sidecar holds what a caller asks for
//! (`/metadata`). Nothing is held in memory across restarts, so a service restart
//! never loses an asset a job already produced.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use axum::extract::{Path as AxumPath, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::util;
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetMeta {
    pub id: String,
    pub filename: String,
    pub mime: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
}

pub struct AssetCache {
    dir: PathBuf,
}

impl AssetCache {
    pub fn open(dir: &str) -> io::Result<Self> {
        let dir = PathBuf::from(dir);
        fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn file_for(&self, meta: &AssetMeta) -> PathBuf {
        let ext = Path::new(&meta.filename)
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_else(|| "bin".into());
        self.dir.join(format!("{}.{}", meta.id, ext))
    }

    fn meta_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// Write the bytes and the sidecar. The caller supplies identity; this only
    /// persists, so a failed write leaves no half-registered asset behind.
    pub fn put(&self, mut meta: AssetMeta, bytes: &[u8]) -> io::Result<AssetMeta> {
        let file = self.file_for(&meta);
        fs::write(&file, bytes)?;
        meta.size = bytes.len() as u64;
        let text = serde_json::to_string_pretty(&meta)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        fs::write(self.meta_path(&meta.id), text)?;
        Ok(meta)
    }

    /// Register an asset whose file was written by a processor (ffmpeg writes to
    /// its own path; copying it into the cache would double the I/O for video).
    pub fn register(&self, mut meta: AssetMeta, file: &Path) -> io::Result<AssetMeta> {
        if !file.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("asset file missing: {}", file.display()),
            ));
        }
        meta.size = fs::metadata(file)?.len();
        let target = self.file_for(&meta);
        if target != file {
            fs::rename(file, &target)?;
        }
        let text = serde_json::to_string_pretty(&meta)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        fs::write(self.meta_path(&meta.id), text)?;
        Ok(meta)
    }

    pub fn read(&self, id: &str) -> Option<AssetMeta> {
        let text = fs::read_to_string(self.meta_path(id)).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn bytes(&self, meta: &AssetMeta) -> io::Result<Vec<u8>> {
        fs::read(self.file_for(meta))
    }

    pub fn list(&self) -> Vec<AssetMeta> {
        let mut out: Vec<AssetMeta> = fs::read_dir(&self.dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
                    .filter_map(|e| fs::read_to_string(e.path()).ok())
                    .filter_map(|t| serde_json::from_str::<AssetMeta>(&t).ok())
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        out
    }

    pub fn delete(&self, id: &str) -> bool {
        let Some(meta) = self.read(id) else { return false };
        let _ = fs::remove_file(self.file_for(&meta));
        let _ = fs::remove_file(self.meta_path(id));
        true
    }

    pub fn clear(&self) -> usize {
        let assets = self.list();
        for meta in &assets {
            let _ = fs::remove_file(self.file_for(meta));
            let _ = fs::remove_file(self.meta_path(&meta.id));
        }
        assets.len()
    }

    pub fn path_of(&self, meta: &AssetMeta) -> PathBuf {
        self.file_for(meta)
    }
}

// ─── routes ──────────────────────────────────────────────────────────────

pub async fn list(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let assets = state.assets.list();
    let count = assets.len();
    crate::ok(serde_json::json!({ "assets": assets, "count": count }))
}

pub async fn download(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, Response> {
    let Some(meta) = state.assets.read(&id) else {
        return Err(not_found(&id));
    };
    let bytes = state
        .assets
        .bytes(&meta)
        .map_err(|e| server_error(&format!("cannot read asset {id}: {e}")))?;
    // A raw filename in the header is both a 500 (non-ASCII) and an injection
    // surface ('"'), so the plain filename is sanitised to ASCII and the real
    // name rides along in RFC 5987 form.
    let ascii: String = meta
        .filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || " .-_()".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded = crate::util::percent_encode(&meta.filename);
    Ok((
        [
            (header::CONTENT_TYPE, meta.mime.clone()),
            (
                header::CONTENT_DISPOSITION,
                format!("inline; filename=\"{ascii}\"; filename*=UTF-8''{encoded}"),
            ),
        ],
        bytes,
    )
        .into_response())
}

pub async fn metadata(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<serde_json::Value>, Response> {
    match state.assets.read(&id) {
        Some(meta) => Ok(crate::ok(meta)),
        None => Err(not_found(&id)),
    }
}

pub async fn delete_one(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<serde_json::Value>, Response> {
    if state.assets.delete(&id) {
        Ok(crate::ok(serde_json::json!({ "deleted": id })))
    } else {
        Err(not_found(&id))
    }
}

pub async fn clear_all(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let cleared = state.assets.clear();
    crate::ok(serde_json::json!({ "cleared": cleared }))
}

fn not_found(id: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "success": false, "error": format!("asset not found: {id}") })),
    )
        .into_response()
}

fn server_error(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "success": false, "error": message })),
    )
        .into_response()
}

/// Build the metadata a processor reports back, with the id already assigned.
pub fn new_meta(filename: &str, mime: &str, width: Option<u32>, height: Option<u32>) -> AssetMeta {
    AssetMeta {
        id: util::id(),
        filename: filename.to_string(),
        mime: mime.to_string(),
        size: 0,
        width,
        height,
        created_at: util::rfc3339_now(),
        source: None,
        job_id: None,
    }
}
