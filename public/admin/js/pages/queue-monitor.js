import { fetchActiveJobs, cancelJob } from '../api-client.js';
import { adminWs } from '../ws-client.js';

export function initQueueMonitorPage(element, nui) {
    const jobList = element.querySelector('#job-list');
    const filterSelect = element.querySelector('#job-filter select');
    const refreshBtn = element.querySelector('#refresh-jobs-btn');
    const clearCompletedBtn = element.querySelector('#clear-completed-btn');

    let jobs = [];
    let subscribedJobs = new Set();

    async function loadJobs() {
        try {
            const data = await fetchActiveJobs({ limit: 100 });
            jobs = data.jobs || [];
            render();
            subscribeVisible();
        } catch (e) {
            jobList.innerHTML = `<nui-banner priority="alert">Failed to load jobs: ${e.message}</nui-banner>`;
        }
    }

    function render() {
        const filter = filterSelect?.value || 'all';
        const visible = jobs.filter(j => filter === 'all' || j.status === filter);

        if (visible.length === 0) {
            jobList.innerHTML = '<p style="color:var(--nui-text-muted)">No jobs found.</p>';
            return;
        }

        jobList.innerHTML = visible.map(j => renderJobCard(j)).join('');

        // Attach cancel handlers
        jobList.querySelectorAll('[data-action="cancel-job"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const jobId = btn.dataset.jobId;
                try {
                    await cancelJob(jobId);
                    loadJobs();
                } catch (e) {
                    nui.components.banner.show({ content: e.message, priority: 'alert', placement: 'bottom', autoClose: 3000 });
                }
            });
        });
    }

    function renderJobCard(j) {
        const isDone = j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled';
        const percent = j.percent || 0;
        const preview = j.status === 'completed' && j.assetId ? renderPreview(j) : '';
        const outputInfo = j.outputPath ? `<div style="font-size:0.8rem;color:var(--nui-text-muted);margin-top:0.25rem;">Output path: ${j.outputPath}</div>` : '';

        return `
            <div class="job-card ${j.status}" data-job-id="${j.jobId}">
                <div class="job-header">
                    <span class="job-processor">${j.processor}</span>
                    <span class="job-status ${j.status}">${j.status}</span>
                    <span class="job-id">${j.jobId}</span>
                    ${j.status === 'queued' ? `<nui-button data-action="cancel-job" data-job-id="${j.jobId}" size="small"><button type="button">Cancel</button></nui-button>` : ''}
                </div>
                <div class="job-message">${j.message || ''}</div>
                <div class="job-progress"><div class="job-progress-bar" style="width:${percent}%"></div></div>
                <div style="font-size:0.8rem;color:var(--nui-text-muted);">
                    ${j.inputPath ? `Path: ${j.inputPath}` : (j.fileId ? `Upload: ${j.fileId}` : '')}
                </div>
                ${outputInfo}
                ${preview ? `<div class="job-output">${preview}</div>` : ''}
            </div>
        `;
    }

    function renderPreview(j) {
        if (!j.assetId) return '';
        const url = `/v1/assets/${j.assetId}`;
        if (j.processor === 'image') {
            return `<div class="job-preview"><img src="${url}" alt="Result" onerror="this.style.display='none'"></div>`;
        }
        if (j.processor === 'audio') {
            return `<div class="job-preview"><audio controls src="${url}"></audio></div>`;
        }
        if (j.processor === 'video') {
            return `<div class="job-preview"><video controls src="${url}" style="max-height:200px;"></video></div>`;
        }
        return `<div><a href="${url}" target="_blank" download>Download Result</a></div>`;
    }

    function subscribeVisible() {
        // Unsubscribe from old
        for (const id of subscribedJobs) {
            adminWs.unsubscribe(id);
        }
        subscribedJobs.clear();

        const filter = filterSelect?.value || 'all';
        const visible = jobs.filter(j => filter === 'all' || j.status === j.status);
        for (const j of visible) {
            if (j.status !== 'completed' && j.status !== 'failed' && j.status !== 'cancelled') {
                adminWs.subscribe(j.jobId);
                subscribedJobs.add(j.jobId);
            }
        }
    }

    function updateJobCard(jobId, updates) {
        const card = jobList.querySelector(`[data-job-id="${jobId}"]`);
        if (!card) return;
        const idx = jobs.findIndex(j => j.jobId === jobId);
        if (idx === -1) return;
        jobs[idx] = { ...jobs[idx], ...updates };
        // Re-render just this card by replacing innerHTML of the list container? Simpler to re-render all for now
        render();
    }

    // WS listeners
    adminWs.on('progress', (data) => {
        updateJobCard(data.jobId, { percent: data.percent, message: data.message, status: 'processing' });
    });

    adminWs.on('complete', (data) => {
        updateJobCard(data.jobId, { percent: 100, message: 'Complete', status: 'completed', assetId: data.assetId || data.result?.assetId });
        adminWs.unsubscribe(data.jobId);
        subscribedJobs.delete(data.jobId);
    });

    adminWs.on('error', (data) => {
        updateJobCard(data.jobId, { message: data.error, status: 'failed' });
        adminWs.unsubscribe(data.jobId);
        subscribedJobs.delete(data.jobId);
    });

    adminWs.on('cancelled', (data) => {
        updateJobCard(data.jobId, { message: 'Cancelled', status: 'cancelled' });
        adminWs.unsubscribe(data.jobId);
        subscribedJobs.delete(data.jobId);
    });

    refreshBtn?.addEventListener('click', loadJobs);
    filterSelect?.addEventListener('change', () => { render(); subscribeVisible(); });
    clearCompletedBtn?.addEventListener('click', () => {
        jobs = jobs.filter(j => j.status !== 'completed' && j.status !== 'failed' && j.status !== 'cancelled');
        render();
    });

    loadJobs();
}
