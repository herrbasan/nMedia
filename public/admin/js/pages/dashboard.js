import { fetchHealth, fetchActiveJobs } from '../api-client.js';

export function initDashboardPage(element, nui) {
    const statsGrid = element.querySelector('#stats-grid');
    const processorList = element.querySelector('#processor-list');

    async function load() {
        try {
            const [health, active] = await Promise.all([
                fetchHealth().catch(() => null),
                fetchActiveJobs({ limit: 1 }).catch(() => null),
            ]);

            if (health) {
                processorList.innerHTML = Object.entries(health.processors || {}).map(([name, status]) => `
                    <div style="display:flex;align-items:center;gap:0.5rem;padding:0.5rem;background:var(--nui-surface-2);border-radius:6px;">
                        <span class="status-dot ${status === 'ready' ? 'connected' : 'disconnected'}"></span>
                        <span style="text-transform:capitalize;font-weight:600;">${name}</span>
                        <span style="margin-left:auto;font-size:0.8rem;color:var(--nui-text-muted);">${status}</span>
                    </div>
                `).join('');
            }

            if (active && active.stats) {
                const s = active.stats;
                statsGrid.innerHTML = `
                    <div class="stat-box"><div class="stat-value">${s.queued}</div><div class="stat-label">Queued</div></div>
                    <div class="stat-box"><div class="stat-value">${s.processing}</div><div class="stat-label">Processing</div></div>
                    <div class="stat-box"><div class="stat-value">${s.completed}</div><div class="stat-label">Completed</div></div>
                    <div class="stat-box"><div class="stat-value">${s.failed}</div><div class="stat-label">Failed</div></div>
                    <div class="stat-box"><div class="stat-value">${s.uploads}</div><div class="stat-label">Uploads</div></div>
                `;
            }
        } catch (e) {
            console.error('Dashboard load failed', e);
        }
    }

    load();
}
