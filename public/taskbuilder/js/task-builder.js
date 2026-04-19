const API_BASE = 'http://localhost:3501';
const PRESET_STORAGE_KEY = 'media-service-presets';

export function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatDuration(seconds) {
    if (!seconds || !isFinite(seconds)) return 'N/A';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0 || h > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}

export async function fetchCapabilities() {
    const res = await fetch(`${API_BASE}/v1/capabilities`);
    if (!res.ok) throw new Error(`Failed to fetch capabilities: ${res.status}`);
    return res.json();
}

export function loadPresets() {
    try {
        return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || '{}');
    } catch {
        return {};
    }
}

export function savePreset(name, options) {
    const presets = loadPresets();
    presets[name] = options;
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
}

export function deletePreset(name) {
    const presets = loadPresets();
    delete presets[name];
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
}

export function getPresetNames() {
    return Object.keys(loadPresets());
}

let wsConnection = null;
let wsMessageCallbacks = [];

export function connectWebSocket(onMessage) {
    return new Promise((resolve, reject) => {
        if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
            wsMessageCallbacks.push(onMessage);
            resolve();
            return;
        }

        wsConnection = new WebSocket(`ws://${API_BASE.replace('http://', '')}/v1/ws`);

        wsConnection.onopen = () => {
            wsMessageCallbacks.push(onMessage);
            resolve();
        };

        wsConnection.onerror = (e) => reject(e);

        wsConnection.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            wsMessageCallbacks.forEach(cb => cb(msg));
        };

        wsConnection.onclose = () => {
            wsConnection = null;
        };
    });
}

export async function runTask(file, inputPath, type, options, transportMode, onProgress, onComplete, onError) {
    let fileId = null;

    if (file) {
        const uploadRes = await fetch(`${API_BASE}/v1/upload`, {
            method: 'POST',
            body: file,
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Original-Filename': file.name || 'unknown',
            },
        });
        if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);
        const uploadData = await uploadRes.json();
        fileId = uploadData.fileId;
    }

    const processBody = { processor: type, options: { ...options } };
    if (fileId) processBody.fileId = fileId;
    else if (inputPath) processBody.input_path = inputPath;

    const processRes = await fetch(`${API_BASE}/v1/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(processBody),
    });
    if (!processRes.ok) {
        const errText = await processRes.text();
        throw new Error(`Process failed: ${processRes.status} ${errText}`);
    }
    const processData = await processRes.json();
    const jobId = processData.jobId;

    return new Promise((resolve, reject) => {
        if (transportMode === 'sse') {
            const evtSource = new EventSource(`${API_BASE}/v1/jobs/${jobId}/progress`);
            evtSource.onmessage = (event) => {
                const data = JSON.parse(event.data);
                handleJobEvent(data, onProgress, onComplete, onError, resolve, reject, evtSource);
            };
            evtSource.onerror = () => {
                evtSource.close();
                reject(new Error('SSE connection error'));
            };
        } else {
            const poll = async () => {
                try {
                    const res = await fetch(`${API_BASE}/v1/jobs/${jobId}`);
                    if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
                    const data = await res.json();

                    if (data.status === 'processing' || data.status === 'queued') {
                        onProgress({ percent: data.percent || 0, message: data.message || data.status });
                        setTimeout(poll, 500);
                    } else if (data.status === 'completed') {
                        onComplete({ assetId: data.assetId });
                        resolve(data);
                    } else if (data.status === 'failed') {
                        onError({ error: data.error || data.message || 'Processing failed' });
                        reject(new Error(data.error || data.message || 'Processing failed'));
                    } else {
                        onProgress({ percent: data.percent || 0, message: data.message || data.status });
                        setTimeout(poll, 500);
                    }
                } catch (e) {
                    reject(e);
                }
            };
            poll();
        }
    });
}

function handleJobEvent(data, onProgress, onComplete, onError, resolve, reject, source) {
    if (data.type === 'progress' || data.status === 'processing') {
        onProgress(data);
    } else if (data.type === 'complete' || data.status === 'completed') {
        onComplete(data);
        source.close();
        resolve(data);
    } else if (data.type === 'error' || data.status === 'failed') {
        onError(data);
        source.close();
        reject(new Error(data.error || 'Processing failed'));
    }
}

export async function downloadAsset(assetId, filename) {
    const res = await fetch(`${API_BASE}/v1/assets/${assetId}`);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.blob();
}

export function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

export async function getAssetMetadata(assetId) {
    try {
        const res = await fetch(`${API_BASE}/v1/assets/${assetId}/metadata`);
        if (!res.ok) return null;
        return res.json();
    } catch {
        return null;
    }
}

export function showProgress(section, bar, status, log, percent, message) {
    if (section) section.style.display = '';
    if (bar) bar.style.width = `${percent}%`;
    if (status) status.textContent = `${percent}% - ${message}`;
    if (log) {
        const entry = document.createElement('div');
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${percent}% - ${message}`;
        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;
    }
}

export function hideProgress(section) {
    if (section) section.style.display = 'none';
}

export function showResult(section, content, html) {
    if (section) section.style.display = '';
    if (content) content.innerHTML = html;
}

export function hideResult(section) {
    if (section) section.style.display = 'none';
}
