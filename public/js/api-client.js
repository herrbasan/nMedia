/**
 * Shared API client for Media Service
 *
 * Auto-detects the API base URL. When the web UI is served from the Node
 * server (same origin), relative URLs are used. When served from an external
 * server such as FiveServer, the client points to the Node backend.
 *
 * Override: localStorage.setItem('ms_api_base', 'http://localhost:3501')
 */

function detectApiBase() {
	const explicit = localStorage.getItem('ms_api_base');
	if (explicit) return explicit;

	// If served from file:// (rare), default to localhost:3501
	if (window.location.protocol === 'file:') return 'http://localhost:3501';

	// If served from Node on port 3501, use relative URLs (same-origin)
	if (window.location.port === '3501') return '';

	// Otherwise assume external server (FiveServer, etc.) → point to Node
	return 'http://localhost:3501';
}

const API_BASE = detectApiBase();

// Expose for inline page scripts that need to construct raw fetch URLs
if (typeof window !== 'undefined') {
	window.API_BASE = API_BASE;
}

let wsConnection = null;
let wsCallbacks = new Map();

export const api = {

	// === Health ===
	async health() {
		const res = await fetch(`${API_BASE}/health`);
		return res.json();
	},

	// === Capabilities ===
	async capabilities(module, section) {
		let url = `${API_BASE}/v1/capabilities`;
		const params = [];
		if (module) params.push(`module=${module}`);
		if (section) params.push(`section=${section}`);
		if (params.length) url += '?' + params.join('&');
		const res = await fetch(url);
		return res.json();
	},

	// === Upload ===
	async upload(file, onProgress) {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open('POST', `${API_BASE}/v1/upload`);
			xhr.setRequestHeader('Content-Type', 'application/octet-stream');
			xhr.setRequestHeader('X-Original-Filename', file.name);

			if (onProgress) {
				xhr.upload.addEventListener('progress', (e) => {
					if (e.lengthComputable) {
						onProgress(Math.round((e.loaded / e.total) * 100));
					}
				});
			}

			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve(JSON.parse(xhr.responseText));
				} else {
					reject(new Error(xhr.responseText));
				}
			};
			xhr.onerror = () => reject(new Error('Upload failed'));
			xhr.send(file);
		});
	},

	// === Process ===
	async process(body) {
		const res = await fetch(`${API_BASE}/v1/process`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const data = await res.json();
		if (!res.ok) {
			throw new Error(data.error || `HTTP ${res.status}`);
		}
		return data;
	},

	// === Jobs ===
	async getJob(jobId) {
		const res = await fetch(`${API_BASE}/v1/jobs/${jobId}`);
		return res.json();
	},

	async cancelJob(jobId) {
		const res = await fetch(`${API_BASE}/v1/jobs/${jobId}`, { method: 'DELETE' });
		return res.json();
	},

	async getJobs() {
		const res = await fetch(`${API_BASE}/v1/jobs`);
		return res.json();
	},

	// === Assets ===
	async getAssets() {
		const res = await fetch(`${API_BASE}/v1/assets`);
		return res.json();
	},

	async getAsset(id) {
		const res = await fetch(`${API_BASE}/v1/assets/${id}`);
		if (!res.ok) throw new Error(`Asset ${id} not found`);
		return res.blob();
	},

	async deleteAsset(id) {
		const res = await fetch(`${API_BASE}/v1/assets/${id}`, { method: 'DELETE' });
		return res.json();
	},

	async clearAssets() {
		const res = await fetch(`${API_BASE}/v1/assets`, { method: 'DELETE' });
		return res.json();
	},

	// === Progress (SSE) ===
	subscribeProgress(jobId, onEvent) {
		const evtSource = new EventSource(`${API_BASE}/v1/jobs/${jobId}/progress`);
		evtSource.addEventListener('message', (e) => {
			try {
				const data = JSON.parse(e.data);
				onEvent(data);
				if (data.type === 'complete' || data.type === 'error' || data.type === 'cancelled') {
					evtSource.close();
				}
			} catch {}
		});
		evtSource.addEventListener('error', () => {
			evtSource.close();
		});
		return evtSource;
	},

	// === WebSocket ===
	connectWebSocket(onMessage, onOpen, onClose) {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		// Use API_BASE host if cross-origin, otherwise current host
		const host = API_BASE ? API_BASE.replace(/^https?:\/\//, '') : window.location.host;
		const ws = new WebSocket(`${protocol}//${host}/v1/ws`);

		ws.onopen = () => {
			if (onOpen) onOpen();
		};

		ws.onmessage = (e) => {
			try {
				const data = JSON.parse(e.data);
				if (onMessage) onMessage(data);
			} catch {
				if (onMessage) onMessage(e.data);
			}
		};

		ws.onclose = () => {
			if (onClose) onClose();
		};

		wsConnection = ws;
		return ws;
	},

	get ws() {
		return wsConnection;
	},

	// === Command builders ===
	buildCurl(endpoint, method, headers, body) {
		const base = API_BASE || `http://localhost:${window.location.port}`;
		let cmd = `curl -X ${method} ${base}${endpoint}`;
		for (const [k, v] of Object.entries(headers || {})) {
			cmd += ` \\\n  -H "${k}: ${v}"`;
		}
		if (body) {
			cmd += ` \\\n  -d '${JSON.stringify(body, null, 2)}'`;
		}
		return cmd;
	},

	buildFetch(endpoint, method, headers, body) {
		const base = API_BASE || `http://localhost:${window.location.port}`;
		const opts = { method, headers };
		if (body) opts.body = JSON.stringify(body, null, 2);
		return `fetch('${base}${endpoint}', ${JSON.stringify(opts, null, 2)})`;
	},

	formatBytes(bytes) {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	},
};
