//! Job store: one JSON file per job, a broadcast channel for SSE, a cancellation
//! notification per job, and a hard admission bound.
//!
//! Design notes that matter (from review of this port's shape):
//!
//! - **Admission is bounded.** A job that cannot get a worker permit is refused
//!   with 429 instead of being queued without limit — unbounded admission grows
//!   memory first and collapses latency second.
//! - **Cancellation kills the child.** A running ffmpeg gets `start_kill()` +
//!   `wait()`, not a flag it never reads. The child is owned by its executor task
//!   and woken through a `Notify`, so there is exactly one owner.
//! - **Terminal state lives on disk**, so a client that missed the SSE event can
//!   always fetch the job. SSE is a convenience, never the record.
//! - **Broadcast can drop** for a lagging receiver; the SSE handler therefore
//!   emits the current state on connect and clients poll on reconnect.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Notify, OwnedSemaphorePermit, Semaphore};

use crate::util;
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    /// queued | processing | completed | failed | cancelled | interrupted
    pub status: String,
    pub progress: u8,
    pub stage: String,
    pub processor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    pub input: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(default)]
    pub options: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Job {
    pub fn terminal(&self) -> bool {
        matches!(
            self.status.as_str(),
            "completed" | "failed" | "cancelled" | "interrupted"
        )
    }
}

pub struct JobStore {
    dir: PathBuf,
    jobs: Mutex<HashMap<String, Job>>,
    order: Mutex<Vec<String>>,
    cancels: Mutex<HashMap<String, Arc<Notify>>>,
    events: broadcast::Sender<Job>,
    workers: Arc<Semaphore>,
    capacity: usize,
}

impl JobStore {
    pub fn open(dir: PathBuf, capacity: usize) -> io::Result<Arc<Self>> {
        fs::create_dir_all(&dir)?;
        let store = Arc::new(Self {
            dir,
            jobs: Mutex::new(HashMap::new()),
            order: Mutex::new(Vec::new()),
            cancels: Mutex::new(HashMap::new()),
            events: broadcast::channel(512).0,
            workers: Arc::new(Semaphore::new(capacity)),
            capacity,
        });
        store.replay()?;
        Ok(store)
    }

    /// Everything that was mid-flight when the process died is `interrupted`:
    /// a poller must see an ending, not a job that never finishes.
    fn replay(&self) -> io::Result<()> {
        let mut jobs = self.jobs.lock().expect("jobs lock");
        let mut order = self.order.lock().expect("order lock");
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            if entry.path().extension().map(|e| e != "json").unwrap_or(true) {
                continue;
            }
            let Ok(text) = fs::read_to_string(entry.path()) else { continue };
            let Ok(mut job) = serde_json::from_str::<Job>(&text) else {
                tracing::warn!("skipping unreadable job record {}", entry.path().display());
                continue;
            };
            if !job.terminal() {
                job.status = "interrupted".into();
                job.error = Some("service restarted while the job was in flight".into());
                job.updated_at = util::rfc3339_now();
                let _ = self.persist(&job);
            }
            order.push(job.id.clone());
            jobs.insert(job.id.clone(), job);
        }
        order.sort();
        Ok(())
    }

    fn persist(&self, job: &Job) -> io::Result<()> {
        let text = serde_json::to_string_pretty(job)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let path = self.dir.join(format!("{}.json", job.id));
        let tmp = self.dir.join(format!("{}.json.tmp", job.id));
        fs::write(&tmp, text)?;
        fs::rename(tmp, path)
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn active_count(&self) -> usize {
        self.jobs
            .lock()
            .map(|j| j.values().filter(|x| !x.terminal()).count())
            .unwrap_or(0)
    }

    /// Admission **reserves** capacity: the permit travels with the job and is
    /// held until its result is published. Try-then-drop would make a burst that
    /// arrives before any job holds a permit pass admission entirely.
    pub async fn admit(
        &self,
        processor: &str,
        mode: Option<&str>,
        input: &str,
    ) -> Result<(Job, OwnedSemaphorePermit), ()> {
        let permit = self.workers.clone().try_acquire_owned().map_err(|_| ())?;

        let now = util::rfc3339_now();
        let job = Job {
            id: util::id(),
            status: "queued".into(),
            progress: 0,
            stage: "queued".into(),
            processor: processor.to_string(),
            mode: mode.map(str::to_string),
            input: input.to_string(),
            output_path: None,
            options: serde_json::Value::Null,
            asset_id: None,
            error: None,
            created_at: now.clone(),
            updated_at: now,
        };
        {
            self.jobs.lock().expect("jobs lock").insert(job.id.clone(), job.clone());
            self.order.lock().expect("order lock").push(job.id.clone());
        }
        let _ = self.persist(&job);
        let _ = self.events.send(job.clone());
        Ok((job, permit))
    }

    /// Compare-and-swap `queued -> processing`. A job cancelled between admission
    /// and this call must not be resurrected by its own executor.
    pub fn begin(&self, id: &str) -> Option<Job> {
        let updated = {
            let mut jobs = self.jobs.lock().expect("jobs lock");
            let job = jobs.get_mut(id)?;
            if job.status != "queued" {
                return None;
            }
            job.status = "processing".into();
            job.progress = 5;
            job.stage = "reading input".into();
            job.updated_at = util::rfc3339_now();
            job.clone()
        };
        let _ = self.persist(&updated);
        let _ = self.events.send(updated.clone());
        Some(updated)
    }

    pub fn mark(&self, id: &str, status: &str, progress: u8, stage: &str) -> Option<Job> {
        let updated = {
            let mut jobs = self.jobs.lock().expect("jobs lock");
            let job = jobs.get_mut(id)?;
            // A terminal state is final: a late executor step must not move a
            // cancelled or finished job back into progress.
            if job.terminal() {
                return None;
            }
            job.status = status.into();
            job.progress = progress;
            job.stage = stage.into();
            job.updated_at = util::rfc3339_now();
            job.clone()
        };
        let _ = self.persist(&updated);
        let _ = self.events.send(updated.clone());
        Some(updated)
    }

    pub fn finish(&self, id: &str, asset_id: Option<String>, output_path: Option<String>) -> Option<Job> {
        let updated = {
            let mut jobs = self.jobs.lock().expect("jobs lock");
            let job = jobs.get_mut(id)?;
            if job.terminal() {
                return None;
            }
            job.status = "completed".into();
            job.progress = 100;
            job.stage = "done".into();
            job.asset_id = asset_id;
            job.output_path = output_path;
            job.updated_at = util::rfc3339_now();
            job.clone()
        };
        self.forget_cancel(id);
        let _ = self.persist(&updated);
        let _ = self.events.send(updated.clone());
        Some(updated)
    }

    /// Failure that does not throw away work: the cache asset stays referenced so
    /// a caller can retrieve it, or retry the publication, without rerunning the
    /// transcode.
    pub fn fail_keeping(&self, id: &str, error: &str, asset_id: Option<String>) -> Option<Job> {
        let updated = {
            let mut jobs = self.jobs.lock().expect("jobs lock");
            let job = jobs.get_mut(id)?;
            if job.terminal() {
                return None;
            }
            job.status = "failed".into();
            job.stage = "publishing".into();
            job.error = Some(error.to_string());
            if asset_id.is_some() {
                job.asset_id = asset_id;
            }
            job.updated_at = util::rfc3339_now();
            job.clone()
        };
        self.forget_cancel(id);
        let _ = self.persist(&updated);
        let _ = self.events.send(updated.clone());
        Some(updated)
    }

    pub fn fail(&self, id: &str, error: &str) -> Option<Job> {
        let updated = {
            let mut jobs = self.jobs.lock().expect("jobs lock");
            let job = jobs.get_mut(id)?;
            if job.terminal() {
                return None;
            }
            job.status = "failed".into();
            job.stage = "failed".into();
            job.error = Some(error.to_string());
            job.updated_at = util::rfc3339_now();
            job.clone()
        };
        self.forget_cancel(id);
        let _ = self.persist(&updated);
        let _ = self.events.send(updated.clone());
        Some(updated)
    }

    fn forget_cancel(&self, id: &str) {
        self.cancels.lock().expect("cancel lock").remove(id);
    }

    pub fn get(&self, id: &str) -> Option<Job> {
        self.jobs.lock().expect("jobs lock").get(id).cloned()
    }

    pub fn list(&self, active_only: bool, limit: usize) -> Vec<Job> {
        let jobs = self.jobs.lock().expect("jobs lock");
        let order = self.order.lock().expect("order lock");
        order
            .iter()
            .rev()
            .filter_map(|id| jobs.get(id).cloned())
            .filter(|job| !active_only || !job.terminal())
            .take(limit)
            .collect()
    }

    /// Register the cancellation handle for a job whose executor is about to run.
    pub fn notify_handle(&self, id: &str) -> Arc<Notify> {
        let notify = Arc::new(Notify::new());
        self.cancels
            .lock()
            .expect("cancel lock")
            .insert(id.to_string(), notify.clone());
        notify
    }

    /// Cancel: queued jobs end immediately, running ones are woken and have their
    /// child killed by the task that owns it.
    pub fn cancel(&self, id: &str) -> Option<Job> {
        let (status, notify) = {
            let jobs = self.jobs.lock().expect("jobs lock");
            let job = jobs.get(id)?;
            if job.terminal() {
                return Some(job.clone());
            }
            let notify = self.cancels.lock().expect("cancel lock").get(id).cloned();
            (job.status.clone(), notify)
        };
        if status == "queued" {
            return self.finish_cancelled(id);
        }
        if let Some(notify) = notify {
            notify.notify_waiters();
            return self.mark(id, "cancelling", 0, "cancelling");
        }
        self.finish_cancelled(id)
    }

    pub fn finish_cancelled(&self, id: &str) -> Option<Job> {
        let updated = {
            let mut jobs = self.jobs.lock().expect("jobs lock");
            let job = jobs.get_mut(id)?;
            job.status = "cancelled".into();
            job.stage = "cancelled".into();
            job.updated_at = util::rfc3339_now();
            job.clone()
        };
        self.forget_cancel(id);
        let _ = self.persist(&updated);
        let _ = self.events.send(updated.clone());
        Some(updated)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Job> {
        self.events.subscribe()
    }
}

// ─── routes ──────────────────────────────────────────────────────────────

pub async fn list_jobs(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let jobs = state.jobs.list(false, 200);
    crate::ok(serde_json::json!({ "jobs": jobs, "count": jobs.len() }))
}

pub async fn list_active(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let jobs = state.jobs.list(true, 200);
    crate::ok(serde_json::json!({ "jobs": jobs, "count": jobs.len() }))
}

pub async fn get_job(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    match state.jobs.get(&id) {
        Some(job) => crate::ok(job).into_response(),
        None => not_found(&id),
    }
}

pub async fn cancel_job(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    match state.jobs.cancel(&id) {
        Some(job) => crate::ok(job).into_response(),
        None => not_found(&id),
    }
}

/// SSE progress. The current state is emitted first, so a client that connects
/// late (or reconnects) still learns the terminal state, and the stream **ends**
/// on that event instead of holding a connection open forever. A lagging receiver
/// gets a `lagged` event rather than silently missing the ending.
pub async fn progress(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<
    Sse<impl tokio_stream::Stream<Item = Result<Event, std::convert::Infallible>>>,
    Response,
> {
    let Some(job) = state.jobs.get(&id) else {
        return Err(not_found(&id));
    };
    let mut rx = state.jobs.subscribe();
    let first = serde_json::to_string(&job).unwrap_or_default();
    let already_terminal = job.terminal();
    let job_id = id.clone();

    let stream = async_stream::stream! {
        yield Ok(Event::default().event("job").data(first));
        if already_terminal {
            return;
        }
        loop {
            match rx.recv().await {
                Ok(update) if update.id == job_id => {
                    let terminal = update.terminal();
                    let payload = serde_json::to_string(&update).unwrap_or_default();
                    yield Ok(Event::default().event("job").data(payload));
                    if terminal {
                        break;
                    }
                }
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    yield Ok(Event::default().event("lagged").data(skipped.to_string()));
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn not_found(id: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "success": false, "error": format!("job not found: {id}") })),
    )
        .into_response()
}
