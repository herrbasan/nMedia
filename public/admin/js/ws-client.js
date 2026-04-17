/**
 * WebSocket client for admin live updates
 */

export class AdminWebSocket {
    constructor() {
        this.ws = null;
        this.listeners = new Map();
        this.status = 'disconnected';
        this.reconnectTimer = null;
        this.url = `ws://${window.location.host}/v1/ws`;
    }

    connect() {
        if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
            return Promise.resolve();
        }
        this._setStatus('connecting');
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);

            this.ws.onopen = () => {
                this._setStatus('connected');
                resolve();
            };

            this.ws.onclose = () => {
                this._setStatus('disconnected');
                this.ws = null;
                this._scheduleReconnect();
            };

            this.ws.onerror = (err) => {
                this._setStatus('disconnected');
                reject(err);
            };

            this.ws.onmessage = (msg) => {
                if (msg.data instanceof Blob) return;
                try {
                    const data = JSON.parse(msg.data);
                    this._notify(data);
                } catch {}
            };
        });
    }

    subscribe(jobId) {
        this._send({ type: 'subscribe', jobId });
    }

    unsubscribe(jobId) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this._send({ type: 'unsubscribe', jobId });
        }
    }

    on(eventType, handler) {
        if (!this.listeners.has(eventType)) {
            this.listeners.set(eventType, new Set());
        }
        this.listeners.get(eventType).add(handler);
        return () => this.listeners.get(eventType).delete(handler);
    }

    _send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    _notify(data) {
        const type = data.type;
        if (this.listeners.has(type)) {
            for (const handler of this.listeners.get(type)) {
                try { handler(data); } catch {}
            }
        }
        if (this.listeners.has('*')) {
            for (const handler of this.listeners.get('*')) {
                try { handler(data); } catch {}
            }
        }
    }

    _setStatus(status) {
        this.status = status;
        const dot = document.getElementById('connection-status');
        if (dot) {
            dot.className = `status-dot ${status}`;
            dot.title = status === 'connected' ? 'WebSocket connected' : 'WebSocket disconnected';
        }
    }

    _scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch(() => {});
        }, 3000);
    }
}

export const adminWs = new AdminWebSocket();
