/**
 * Admin API Client
 * HTTP + WebSocket wrapper for the Media Service admin UI
 */

const API_BASE = '';

export async function fetchHealth() {
    const res = await fetch(`${API_BASE}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

export async function fetchActiveJobs(params = {}) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${API_BASE}/v1/jobs/active${qs ? '?' + qs : ''}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

export async function fetchJob(jobId) {
    const res = await fetch(`${API_BASE}/v1/jobs/${jobId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

export async function cancelJob(jobId) {
    const res = await fetch(`${API_BASE}/v1/jobs/${jobId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

export async function uploadFile(file) {
    const res = await fetch(`${API_BASE}/v1/upload`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': file.size.toString(),
            'X-Original-Filename': file.name,
        },
        body: file,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
}

export async function processJob(body) {
    const res = await fetch(`${API_BASE}/v1/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
}

export async function fetchAsset(assetId) {
    const res = await fetch(`${API_BASE}/v1/assets/${assetId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
}

export async function fetchAssetMetadata(assetId) {
    const res = await fetch(`${API_BASE}/v1/assets/${assetId}/metadata`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

export function getAssetUrl(assetId) {
    return `${API_BASE}/v1/assets/${assetId}`;
}
