const API_BASE = 'http://localhost:3501';
const WS_BASE = 'ws://localhost:3501';

let capabilitiesCache = null;

async function fetchCapabilities() {
    if (capabilitiesCache) return capabilitiesCache;
    try {
        const response = await fetch(`${API_BASE}/v1/capabilities`);
        if (response.ok) {
            const result = await response.json();
            if (result.success) {
                capabilitiesCache = result.data;
                return capabilitiesCache;
            }
        }
    } catch (e) {
        console.warn('Failed to fetch capabilities:', e);
    }
    return null;
}

function populateAudioCodecs(caps) {
    const select = document.querySelector('#transport-audio-codec-select');
    if (!select || !caps) return;
    const encoders = caps.commonCodecs?.encoders?.audio || [];
    select.innerHTML = '<option value="">Auto</option>';
    encoders.forEach(codec => {
        const opt = document.createElement('option');
        opt.value = codec.name;
        opt.textContent = codec.longName || codec.name;
        select.appendChild(opt);
    });
}

function populateImageFormats(caps) {
    if (!caps) return;

    const formatSelect = document.querySelector('#transport-image-format select');
    if (formatSelect) {
        const encoders = caps.encoders?.formats || ['jpeg', 'png', 'webp', 'avif', 'tiff'];
        formatSelect.innerHTML = '';
        encoders.forEach(fmt => {
            const opt = document.createElement('option');
            opt.value = fmt;
            opt.textContent = fmt.toUpperCase();
            formatSelect.appendChild(opt);
        });
    }
}

function populateVideoOptions(caps) {
    if (!caps) return;

    const containerSelect = document.querySelector('#transport-video-container-select');
    if (containerSelect) {
        const videoFormats = (caps.formats || []).filter(f => f.canMux && ['mp4', 'mkv', 'webm', 'avi', 'mov', 'ts', 'flv', 'ogg'].some(ext => f.extensions?.includes(ext)));
        containerSelect.innerHTML = '<option value="">Auto</option>';
        videoFormats.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.extensions[0];
            opt.textContent = f.name;
            containerSelect.appendChild(opt);
        });
    }

    const codecSelect = document.querySelector('#transport-video-codec-select');
    if (codecSelect) {
        const allVideoEncoders = caps.commonCodecs?.encoders?.video || {};
        const cpuEncoders = allVideoEncoders.cpu || [];
        codecSelect.innerHTML = '<option value="">Auto</option>';
        cpuEncoders.forEach(codec => {
            const opt = document.createElement('option');
            opt.value = codec.name;
            opt.textContent = codec.longName || codec.name;
            codecSelect.appendChild(opt);
        });
    }

    const audioCodecSelect = document.querySelector('#transport-video-audio-codec-select');
    if (audioCodecSelect) {
        const audioEncoders = caps.commonCodecs?.encoders?.audio || [];
        audioCodecSelect.innerHTML = '<option value="">Auto</option>';
        audioEncoders.forEach(codec => {
            const opt = document.createElement('option');
            opt.value = codec.name;
            opt.textContent = codec.longName || codec.name;
            audioCodecSelect.appendChild(opt);
        });
    }

    const hwaccelSelect = document.querySelector('#transport-video-hwaccel-select');
    if (hwaccelSelect) {
        const hwaccels = caps.commonCodecs?.videoEncodersByHwaccel || {};
        hwaccelSelect.innerHTML = '<option value="">Auto</option>';
        Object.keys(hwaccels).forEach(hw => {
            if (hw !== 'cpu') {
                const opt = document.createElement('option');
                opt.value = hw;
                opt.textContent = hw.toUpperCase();
                hwaccelSelect.appendChild(opt);
            }
        });
    }

    const recommendedDiv = document.querySelector('#transport-video-recommended');
    if (recommendedDiv && caps.commonCodecs?.recommended) {
        const rec = caps.commonCodecs.recommended;
        recommendedDiv.innerHTML = `<strong>Recommended:</strong> ${Object.entries(rec).map(([k, v]) => `${k}: ${v.video || ''}/${v.audio || ''}`).join(' | ')}`;
    }
}

export function initTransportTestsPage(element, nui) {
    console.log('transport tests init');

    fetchCapabilities().then(caps => {
        const nVideoCaps = caps?.nVideo || caps;
        const nImageCaps = caps?.nImage || {};
        populateAudioCodecs(nVideoCaps);
        populateVideoOptions(nVideoCaps);
        populateImageFormats(nImageCaps);
    });

    let selectedFile = null;
    let testResultsData = [];
    let ws = null;
    let wsDownloadBuffer = [];
    let wsDownloadExpected = null;
    let lastJobId = null;
    let lastAssetId = null;

    const workflowSelect = element.querySelector('#workflow-select select');
    const pathInputContainer = element.querySelector('#path-input-container');
    const inputPathField = element.querySelector('#input-path-field input');
    const filePicker = element.querySelector('#transport-file-picker');
    const fileInfo = element.querySelector('#transport-file-info');
    const processorSelect = element.querySelector('#transport-processor-select select');
    const audioOptions = element.querySelector('#transport-audio-options');
    const videoOptions = element.querySelector('#transport-video-options');
    const imageOptions = element.querySelector('#transport-image-options');
    const progressSection = element.querySelector('#transport-progress-section');
    const progressBar = element.querySelector('#transport-progress-bar');
    const progressStatus = element.querySelector('#transport-progress-status');
    const progressLog = element.querySelector('#transport-progress-log');
    const resultSection = element.querySelector('#transport-result-section');
    const resultContent = element.querySelector('#transport-result-content');
    const runUploadBtn = element.querySelector('#run-upload-test-btn');
    const runPathBtn = element.querySelector('#run-path-test-btn');
    const runAllBtn = element.querySelector('#run-all-transport-tests-btn');
    const testsResultsSection = element.querySelector('#transport-tests-results-section');
    const testSummary = element.querySelector('#transport-test-summary');
    const testResults = element.querySelector('#transport-test-results');
    const transportModeSelect = element.querySelector('#transport-mode-select select');
    const wsStatusContainer = element.querySelector('#websocket-status');
    const wsStatusDot = element.querySelector('#ws-status-dot');
    const wsStatusText = element.querySelector('#ws-status-text');
    const eventLogSection = element.querySelector('#transport-event-log-section');
    const eventLog = element.querySelector('#transport-event-log');
    const wsBinaryUploadBtn = element.querySelector('#ws-binary-upload-btn');
    const wsBinaryDownloadBtn = element.querySelector('#ws-binary-download-btn');
    const wsBinaryInfo = element.querySelector('#ws-binary-info');

    workflowSelect?.addEventListener('change', () => {
        const workflow = workflowSelect.value;
        pathInputContainer.style.display = workflow === 'path' ? 'block' : 'none';
        if (workflow === 'upload') {
            runUploadBtn.style.display = '';
            runPathBtn.style.display = 'none';
        } else {
            runUploadBtn.style.display = 'none';
            runPathBtn.style.display = '';
        }
    });

    processorSelect?.addEventListener('change', () => {
        const proc = processorSelect.value;
        audioOptions.style.display = proc === 'audio' ? '' : 'none';
        videoOptions.style.display = proc === 'video' ? '' : 'none';
        imageOptions.style.display = proc === 'image' ? '' : 'none';
    });

    const videoModeSelect = element.querySelector('#transport-video-mode select');
    const transcodeOptionsDiv = element.querySelector('#transport-video-transcode-options');
    videoModeSelect?.addEventListener('change', () => {
        if (transcodeOptionsDiv) {
            transcodeOptionsDiv.style.display = videoModeSelect.value === 'transcode' ? 'block' : 'none';
        }
    });

    filePicker?.addEventListener('nui-file-selected', (e) => {
        if (e.detail.files.length > 0) {
            selectedFile = e.detail.files[0];
            fileInfo.innerHTML = `<strong>${selectedFile.name}</strong> — ${formatFileSize(selectedFile.size)} — ${selectedFile.type || 'Unknown'}`;
        }
    });

    transportModeSelect?.addEventListener('change', () => {
        const mode = transportModeSelect.value;
        wsStatusContainer.style.display = mode === 'websocket' ? 'block' : 'none';
        if (mode === 'websocket') {
            ensureWebSocket();
        } else if (ws) {
            ws.close();
            ws = null;
            updateWsStatus('disconnected');
        }
    });

    runUploadBtn?.addEventListener('click', () => {
        if (!selectedFile) {
            nui.components.banner.show({ content: 'Please select a file first', priority: 'alert', placement: 'bottom', autoClose: 3000 });
            return;
        }
        runUploadWorkflow(selectedFile);
    });

    runPathBtn?.addEventListener('click', () => {
        const inputPath = inputPathField?.value?.trim();
        if (!inputPath) {
            nui.components.banner.show({ content: 'Please enter an input path', priority: 'alert', placement: 'bottom', autoClose: 3000 });
            return;
        }
        runPathWorkflow(inputPath);
    });

    runAllBtn?.addEventListener('click', runAllTransportTests);

    wsBinaryUploadBtn?.addEventListener('click', () => {
        if (!selectedFile) {
            nui.components.banner.show({ content: 'Please select a file first', priority: 'alert', placement: 'bottom', autoClose: 3000 });
            return;
        }
        runWsBinaryUpload(selectedFile);
    });

    wsBinaryDownloadBtn?.addEventListener('click', () => {
        if (lastAssetId) {
            runWsBinaryDownload(lastAssetId);
        }
    });

    function updateWsStatus(state) {
        if (!wsStatusDot || !wsStatusText) return;
        if (state === 'connected') {
            wsStatusDot.style.background = '#4caf50';
            wsStatusText.textContent = 'WebSocket connected';
        } else if (state === 'connecting') {
            wsStatusDot.style.background = '#ff9800';
            wsStatusText.textContent = 'WebSocket connecting...';
        } else {
            wsStatusDot.style.background = '#888';
            wsStatusText.textContent = 'WebSocket disconnected';
        }
    }

    function ensureWebSocket() {
        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
            return Promise.resolve(ws);
        }
        return new Promise((resolve, reject) => {
            updateWsStatus('connecting');
            ws = new WebSocket(`${WS_BASE}/v1/ws`);

            ws.onopen = () => {
                updateWsStatus('connected');
                logTransportEvent('→', { type: 'connect', url: `${WS_BASE}/v1/ws` });
                resolve(ws);
            };

            ws.onclose = () => {
                updateWsStatus('disconnected');
                logTransportEvent('→', { type: 'disconnect' });
                ws = null;
            };

            ws.onerror = (err) => {
                updateWsStatus('disconnected');
                logTransportEvent('→', { type: 'error', message: 'WebSocket error' });
                nui.components.banner.show({ content: 'WebSocket error', priority: 'alert', placement: 'bottom', autoClose: 3000 });
                reject(err);
            };

            ws.onmessage = (msg) => {
                if (msg.data instanceof Blob) {
                    handleWsBinaryMessage(msg.data);
                    return;
                }
                try {
                    const data = JSON.parse(msg.data);
                    logTransportEvent('←', data);

                    if (data.type === 'upload_ready') {
                        wsBinaryInfo.innerHTML = `<strong>Upload ready:</strong> fileId=${data.fileId}, type=${data.detectedType}, size=${formatFileSize(data.size)}`;
                        nui.components.banner.show({ content: `Upload ready: ${data.fileId}`, priority: 'info', placement: 'bottom', autoClose: 3000 });
                    }

                    if (data.type === 'download_ready') {
                        wsDownloadExpected = data.assetId;
                        wsDownloadBuffer = [];
                    }

                    if (data.type === 'download_complete') {
                        finalizeWsDownload();
                    }
                } catch {
                    logTransportEvent('←', { type: 'raw', data: msg.data });
                }
            };
        });
    }

    async function handleWsBinaryMessage(blob) {
        const arrayBuffer = await blob.arrayBuffer();
        wsDownloadBuffer.push(new Uint8Array(arrayBuffer));
        logTransportEvent('←', { type: 'binary', size: arrayBuffer.byteLength });
    }

    function finalizeWsDownload() {
        if (!wsDownloadExpected || wsDownloadBuffer.length === 0) return;
        let totalLength = 0;
        wsDownloadBuffer.forEach(b => totalLength += b.length);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        wsDownloadBuffer.forEach(b => {
            combined.set(b, offset);
            offset += b.length;
        });
        const blob = new Blob([combined]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ws-download-${wsDownloadExpected}`;
        a.click();
        URL.revokeObjectURL(url);
        wsBinaryInfo.innerHTML = `<strong>Download complete:</strong> assetId=${wsDownloadExpected}, size=${formatFileSize(totalLength)}`;
        wsDownloadExpected = null;
        wsDownloadBuffer = [];
    }

    async function runWsBinaryUpload(file) {
        await ensureWebSocket();
        wsBinaryInfo.innerHTML = 'Starting WebSocket binary upload...';

        const uploadId = `ws-upload-${Date.now()}`;
        ws.send(JSON.stringify({
            type: 'upload_start',
            uploadId,
            filename: file.name,
            size: file.size,
        }));

        const chunkSize = 64 * 1024;
        const arrayBuffer = await file.arrayBuffer();
        let offset = 0;

        while (offset < arrayBuffer.byteLength) {
            const chunk = arrayBuffer.slice(offset, offset + chunkSize);
            ws.send(chunk);
            offset += chunkSize;
        }

        ws.send(JSON.stringify({
            type: 'upload_complete',
            uploadId,
        }));

        wsBinaryInfo.innerHTML = `Sent ${formatFileSize(file.size)} via WebSocket. Waiting for server...`;
    }

    async function runWsBinaryDownload(assetId) {
        await ensureWebSocket();
        wsBinaryInfo.innerHTML = `Requesting download for ${assetId}...`;
        ws.send(JSON.stringify({
            type: 'download_request',
            assetId,
        }));
    }

    function logTransportEvent(direction, data) {
        if (!eventLog) return;
        eventLogSection.style.display = 'block';
        const entry = document.createElement('div');
        entry.style.marginBottom = '0.25rem';
        entry.style.borderBottom = '1px solid var(--nui-border)';
        entry.style.paddingBottom = '0.25rem';
        const time = new Date().toLocaleTimeString();
        const color = direction === '→' ? '#4da6ff' : '#7ee787';
        entry.innerHTML = `<span style="color: var(--nui-text-muted);">[${time}]</span> <span style="color: ${color}; font-weight: 600;">${direction}</span> <code style="font-size: 0.75rem;">${escapeHtml(JSON.stringify(data))}</code>`;
        eventLog.appendChild(entry);
        eventLog.scrollTop = eventLog.scrollHeight;
    }

    function getProcessingOptions() {
        const processor = processorSelect.value;
        const options = {};

        if (processor === 'audio') {
            options.sample_rate = parseInt(element.querySelector('#transport-audio-samplerate select')?.value || '16000');
            options.format = element.querySelector('#transport-audio-format select')?.value || 'mp3';
            options.channels = 1;
            const audioCodec = element.querySelector('#transport-audio-codec-select')?.value;
            if (audioCodec) options.audio_codec = audioCodec;
        } else if (processor === 'video') {
            const mode = element.querySelector('#transport-video-mode select')?.value || 'extract_audio';
            options.mode = mode;
            if (mode === 'transcode') {
                const container = element.querySelector('#transport-video-container-select')?.value;
                const videoCodec = element.querySelector('#transport-video-codec-select')?.value;
                const audioCodec = element.querySelector('#transport-video-audio-codec-select')?.value;
                const hwaccel = element.querySelector('#transport-video-hwaccel-select')?.value;
                if (container) options.output_format = container;
                if (videoCodec) options.video_codec = videoCodec;
                if (audioCodec) options.audio_codec = audioCodec;
                if (hwaccel) options.hwaccel = hwaccel;
            }
        } else if (processor === 'image') {
            options.max_dimension = parseInt(element.querySelector('#transport-image-maxdim input')?.value || '1024');
            options.format = element.querySelector('#transport-image-format select')?.value || 'jpeg';
            options.quality = 85;
        }

        return { processor, options };
    }

    async function runUploadWorkflow(file) {
        resetProgress();
        hideResult();
        showProgress();
        clearEventLog();

        const { processor, options } = getProcessingOptions();

        try {
            addLog(`Step 1: Uploading ${file.name} (${formatFileSize(file.size)})...`);
            updateProgress(5, 'Uploading file...');

            const uploadResponse = await uploadFile(file);

            if (!uploadResponse.ok) {
                const errorText = await uploadResponse.text();
                throw new Error(`Upload failed: HTTP ${uploadResponse.status} - ${errorText}`);
            }

            const uploadData = await uploadResponse.json();
            addLog(`Upload complete. fileId: ${uploadData.fileId}, detected: ${uploadData.detectedType}`);
            updateProgress(20, 'File uploaded, starting processing...');

            await processWithFileId(uploadData.fileId, processor, options);
        } catch (error) {
            addLog(`ERROR: ${error.message}`);
            updateProgress(0, 'Failed');
            nui.components.banner.show({ content: error.message, priority: 'alert', placement: 'bottom', autoClose: 5000 });
        }
    }

    async function runPathWorkflow(inputPath) {
        resetProgress();
        hideResult();
        showProgress();
        clearEventLog();

        const { processor, options } = getProcessingOptions();

        try {
            addLog(`Step 1: Processing file at ${inputPath}...`);
            updateProgress(5, 'Starting path-based processing...');

            await processWithPath(inputPath, processor, options);
        } catch (error) {
            addLog(`ERROR: ${error.message}`);
            updateProgress(0, 'Failed');
            nui.components.banner.show({ content: error.message, priority: 'alert', placement: 'bottom', autoClose: 5000 });
        }
    }

    async function uploadFile(file) {
        return fetch(`${API_BASE}/v1/upload`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': file.size.toString(),
                'X-Original-Filename': file.name,
            },
            body: file,
        });
    }

    async function processWithFileId(fileId, processor, options) {
        addLog(`Step 2: Submitting processing job (processor: ${processor})...`);
        updateProgress(25, 'Submitting job...');

        const processBody = { fileId, processor, options };

        const processResponse = await fetch(`${API_BASE}/v1/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(processBody),
        });

        if (!processResponse.ok) {
            const errorText = await processResponse.text();
            throw new Error(`Process failed: HTTP ${processResponse.status} - ${errorText}`);
        }

        const processData = await processResponse.json();
        const jobId = processData.jobId;
        lastJobId = jobId;
        addLog(`Job created: ${jobId}, status: ${processData.status}`);

        const transportMode = transportModeSelect.value;
        if (transportMode === 'sse') {
            await trackJobWithSse(jobId);
        } else if (transportMode === 'websocket') {
            await trackJobWithWebSocket(jobId);
        } else {
            await pollJobProgress(jobId);
        }
    }

    async function processWithPath(inputPath, processor, options) {
        addLog(`Step 1: Submitting path-based job...`);
        updateProgress(10, 'Submitting job...');

        const processBody = { input_path: inputPath, processor, options };

        const processResponse = await fetch(`${API_BASE}/v1/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(processBody),
        });

        if (!processResponse.ok) {
            const errorText = await processResponse.text();
            throw new Error(`Process failed: HTTP ${processResponse.status} - ${errorText}`);
        }

        const processData = await processResponse.json();
        const jobId = processData.jobId;
        lastJobId = jobId;
        addLog(`Job created: ${jobId}, status: ${processData.status}`);

        const transportMode = transportModeSelect.value;
        if (transportMode === 'sse') {
            await trackJobWithSse(jobId);
        } else if (transportMode === 'websocket') {
            await trackJobWithWebSocket(jobId);
        } else {
            await pollJobProgress(jobId);
        }
    }

    function trackJobWithSse(jobId) {
        return new Promise((resolve, reject) => {
            addLog('Connecting to SSE progress stream...');
            const source = new EventSource(`${API_BASE}/v1/jobs/${jobId}/progress`);
            let resolved = false;

            source.onopen = () => {
                logTransportEvent('→', { type: 'sse_connect', jobId });
            };

            source.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    logTransportEvent('←', { type: e.type, ...data });

                    if (data.event === 'progress') {
                        updateProgress(data.percent || 0, data.message || 'Processing...');
                        if (data.percent) {
                            addLog(`Progress: ${data.percent}% - ${data.message || ''}`);
                        }
                    } else if (data.event === 'complete') {
                        updateProgress(100, 'Complete');
                        source.close();
                        if (!resolved) {
                            resolved = true;
                            resolve({ jobId, ...data });
                        }
                    } else if (data.event === 'error') {
                        source.close();
                        if (!resolved) {
                            resolved = true;
                            reject(new Error(data.error));
                        }
                    }
                } catch (err) {
                    logTransportEvent('←', { type: 'sse_raw', data: e.data });
                }
            };

            source.onerror = (err) => {
                logTransportEvent('←', { type: 'sse_error' });
                if (!resolved) {
                    resolved = true;
                    reject(new Error('SSE connection failed'));
                }
            };
        }).then(async (job) => {
            await showResult({ jobId, assetId: job.result?.assetId || job.assetId });
        }).catch((err) => {
            addLog(`ERROR: ${err.message}`);
            updateProgress(0, 'Failed');
            throw err;
        });
    }

    async function trackJobWithWebSocket(jobId) {
        await ensureWebSocket();
        return new Promise((resolve, reject) => {
            addLog('Subscribing to job via WebSocket...');
            ws.send(JSON.stringify({ type: 'subscribe', jobId }));
            logTransportEvent('→', { type: 'subscribe', jobId });

            const handler = (msg) => {
                if (msg.data instanceof Blob) return;
                let data;
                try { data = JSON.parse(msg.data); } catch { return; }
                if (data.jobId !== jobId) return;

                if (data.type === 'progress') {
                    updateProgress(data.percent || 0, data.message || 'Processing...');
                    if (data.percent) {
                        addLog(`Progress: ${data.percent}% - ${data.message || ''}`);
                    }
                } else if (data.type === 'complete') {
                    const assetId = data.assetId || data.result?.assetId;
                    if (assetId) {
                        ws.removeEventListener('message', handler);
                        updateProgress(100, 'Complete');
                        resolve(data);
                    } else {
                        addLog('Progress: 100% - Waiting for asset ID...');
                    }
                } else if (data.type === 'error') {
                    ws.removeEventListener('message', handler);
                    reject(new Error(data.error));
                } else if (data.type === 'cancelled') {
                    ws.removeEventListener('message', handler);
                    reject(new Error('Job cancelled'));
                }
            };

            ws.addEventListener('message', handler);
        }).then(async (data) => {
            await showResult({ jobId, assetId: data.assetId || data.result?.assetId });
        }).catch((err) => {
            addLog(`ERROR: ${err.message}`);
            updateProgress(0, 'Failed');
            throw err;
        });
    }

    async function pollJobProgress(jobId) {
        addLog('Polling for progress...');

        const pollInterval = 500;
        let lastPercent = 0;

        return new Promise((resolve, reject) => {
            const poll = async () => {
                try {
                    const response = await fetch(`${API_BASE}/v1/jobs/${jobId}`);
                    if (!response.ok) {
                        reject(new Error(`Poll failed: HTTP ${response.status}`));
                        return;
                    }

                    const job = await response.json();
                    updateProgress(job.percent || 0, job.message || job.status);

                    if (job.percent !== lastPercent) {
                        addLog(`Progress: ${job.percent}% - ${job.message || job.status}`);
                        lastPercent = job.percent;
                    }

                    if (job.status === 'completed') {
                        addLog('Job completed!');
                        updateProgress(100, 'Complete');
                        await showResult(job);
                        resolve(job);
                    } else if (job.status === 'failed') {
                        addLog(`Job failed: ${job.error}`);
                        updateProgress(0, 'Failed');
                        reject(new Error(job.error || 'Processing failed'));
                    } else if (job.status === 'cancelled') {
                        addLog('Job cancelled');
                        updateProgress(0, 'Cancelled');
                        reject(new Error('Job cancelled'));
                    } else {
                        setTimeout(poll, pollInterval);
                    }
                } catch (err) {
                    reject(err);
                }
            };

            poll();
        });
    }

    async function showResult(job) {
        lastAssetId = job.assetId;
        wsBinaryDownloadBtn.disabled = !lastAssetId;

        if (!job.assetId) {
            resultContent.innerHTML = `<p>Job completed but no asset was produced.</p>`;
            showResultSection();
            return;
        }

        const assetResponse = await fetch(`${API_BASE}/v1/assets/${job.assetId}/metadata`);
        const assetMeta = assetResponse.ok ? await assetResponse.json() : null;

        let html = `<div style="margin-bottom: 1rem;">`;
        html += `<p><strong>Job ID:</strong> ${job.jobId || lastJobId}</p>`;
        html += `<p><strong>Asset ID:</strong> ${job.assetId}</p>`;
        if (assetMeta) {
            html += `<p><strong>Output size:</strong> ${formatFileSize(assetMeta.size)}</p>`;
            html += `<p><strong>Format:</strong> ${assetMeta.mimeType}</p>`;
        }
        html += `</div>`;

        html += `<nui-button variant="primary" id="download-result-btn">
            <button type="button"><nui-icon name="download">⬇</nui-icon> Download Result</button>
        </nui-button>`;

        resultContent.innerHTML = html;
        showResultSection();

        setTimeout(() => {
            const downloadBtn = element.querySelector('#download-result-btn');
            downloadBtn?.addEventListener('click', async () => {
                const response = await fetch(`${API_BASE}/v1/assets/${job.assetId}`);
                if (response.ok) {
                    const blob = await response.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `result-${job.assetId}`;
                    a.click();
                    URL.revokeObjectURL(url);
                }
            });
        }, 100);
    }

    async function runAllTransportTests() {
        testResultsData = [];
        clearTestResults();
        testsResultsSection.style.display = 'block';

        await runTransportTest('upload-audio', 'Upload + Audio Process');
        await runTransportTest('path-audio', 'Path + Audio Process');
        await runTransportTest('upload-image', 'Upload + Image Process');
        await runTransportTest('websocket-e2e', 'WebSocket E2E Binary');

        updateTestSummary();
    }

    async function runTransportTest(testId, label) {
        addTestResult(testId, 'running', 'Running...');
        const startTime = performance.now();

        try {
            let result;
            if (testId === 'upload-audio') {
                result = await testUploadAudio();
            } else if (testId === 'path-audio') {
                result = await testPathAudio();
            } else if (testId === 'upload-image') {
                result = await testUploadImage();
            } else if (testId === 'websocket-e2e') {
                result = await testWebSocketE2E();
            }

            const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
            updateTestResult(testId, 'pass', { elapsed, ...result });
        } catch (error) {
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
            updateTestResult(testId, 'fail', { elapsed, error: error.message });
        }
    }

    async function testUploadAudio() {
        const testFile = await fetchTestFile('tests/assets/audio/Vangengel.wav');
        if (!testFile) throw new Error('Test file not found: Vangengel.wav');

        const uploadResponse = await uploadFile(testFile);
        if (!uploadResponse.ok) throw new Error(`Upload failed: HTTP ${uploadResponse.status}`);

        const uploadData = await uploadResponse.json();
        if (!uploadData.fileId) throw new Error('No fileId in upload response');

        const processResponse = await fetch(`${API_BASE}/v1/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileId: uploadData.fileId,
                processor: 'audio',
                options: { sample_rate: 16000, channels: 1, format: 'mp3' },
            }),
        });

        if (!processResponse.ok) throw new Error(`Process failed: HTTP ${processResponse.status}`);

        const processData = await processResponse.json();
        const job = await pollUntilComplete(processData.jobId);

        if (job.status !== 'completed') throw new Error(`Job ended with status: ${job.status}`);
        if (!job.assetId) throw new Error('No assetId in completed job');

        return {
            fileId: uploadData.fileId,
            jobId: job.jobId,
            assetId: job.assetId,
            uploadSize: uploadData.size,
        };
    }

    async function testPathAudio() {
        const testPath = 'D:\\Work\\_GIT\\MediaService\\tests\\assets\\audio\\Vangengel.wav';

        const processResponse = await fetch(`${API_BASE}/v1/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                input_path: testPath,
                processor: 'audio',
                options: { sample_rate: 16000, channels: 1, format: 'mp3' },
            }),
        });

        if (!processResponse.ok) {
            const errorText = await processResponse.text();
            throw new Error(`Process failed: HTTP ${processResponse.status} - ${errorText}`);
        }

        const processData = await processResponse.json();
        const job = await pollUntilComplete(processData.jobId);

        if (job.status !== 'completed') throw new Error(`Job ended with status: ${job.status}`);
        if (!job.assetId) throw new Error('No assetId in completed job');

        return {
            jobId: job.jobId,
            assetId: job.assetId,
            inputPath: testPath,
        };
    }

    async function testUploadImage() {
        const testFile = await fetchTestFile('tests/assets/images/116.png');
        if (!testFile) throw new Error('Test file not found: 116.png');

        const uploadResponse = await uploadFile(testFile);
        if (!uploadResponse.ok) throw new Error(`Upload failed: HTTP ${uploadResponse.status}`);

        const uploadData = await uploadResponse.json();

        const processResponse = await fetch(`${API_BASE}/v1/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileId: uploadData.fileId,
                processor: 'image',
                options: { max_dimension: 256, quality: 80, format: 'jpeg' },
            }),
        });

        if (!processResponse.ok) throw new Error(`Process failed: HTTP ${processResponse.status}`);

        const processData = await processResponse.json();
        const job = await pollUntilComplete(processData.jobId);

        if (job.status !== 'completed') throw new Error(`Job ended with status: ${job.status}`);
        if (!job.assetId) throw new Error('No assetId in completed job');

        return {
            fileId: uploadData.fileId,
            jobId: job.jobId,
            assetId: job.assetId,
        };
    }

    async function testWebSocketE2E() {
        const testFile = await fetchTestFile('tests/assets/audio/Vangengel.wav');
        if (!testFile) throw new Error('Test file not found: Vangengel.wav');

        await ensureWebSocket();

        const uploadResponse = await uploadFile(testFile);
        if (!uploadResponse.ok) throw new Error(`Upload failed: HTTP ${uploadResponse.status}`);

        const uploadData = await uploadResponse.json();
        if (!uploadData.fileId) throw new Error('No fileId in upload response');

        const processResponse = await fetch(`${API_BASE}/v1/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileId: uploadData.fileId,
                processor: 'audio',
                options: { sample_rate: 16000, channels: 1, format: 'mp3' },
            }),
        });

        if (!processResponse.ok) throw new Error(`Process failed: HTTP ${processResponse.status}`);

        const processData = await processResponse.json();

        const wsResult = await new Promise((resolve, reject) => {
            const jobId = processData.jobId;
            ws.send(JSON.stringify({ type: 'subscribe', jobId }));

            const handler = (msg) => {
                if (msg.data instanceof Blob) return;
                let data;
                try { data = JSON.parse(msg.data); } catch { return; }
                if (data.jobId !== jobId) return;

                if (data.type === 'complete') {
                    const assetId = data.assetId || data.result?.assetId;
                    if (assetId) {
                        ws.removeEventListener('message', handler);
                        resolve(data);
                    }
                } else if (data.type === 'error') {
                    ws.removeEventListener('message', handler);
                    reject(new Error(data.error));
                } else if (data.type === 'cancelled') {
                    ws.removeEventListener('message', handler);
                    reject(new Error('Job cancelled'));
                }
            };

            ws.addEventListener('message', handler);

            setTimeout(() => {
                ws.removeEventListener('message', handler);
                reject(new Error('WebSocket progress timeout'));
            }, 30000);
        });

        const assetId = wsResult.assetId || wsResult.result?.assetId;
        if (!assetId) throw new Error('assetId is required');

        const downloadResponse = await fetch(`${API_BASE}/v1/assets/${assetId}`);
        if (!downloadResponse.ok) throw new Error(`Download failed: HTTP ${downloadResponse.status}`);

        const downloadedBlob = await downloadResponse.blob();
        if (!downloadedBlob.size) throw new Error('Downloaded asset is empty');

        return {
            fileId: uploadData.fileId,
            jobId: processData.jobId,
            assetId,
            downloadSize: downloadedBlob.size,
        };
    }

    async function pollUntilComplete(jobId) {
        return new Promise((resolve, reject) => {
            const poll = async () => {
                try {
                    const response = await fetch(`${API_BASE}/v1/jobs/${jobId}`);
                    if (!response.ok) {
                        reject(new Error(`Poll failed: HTTP ${response.status}`));
                        return;
                    }
                    const job = await response.json();
                    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
                        resolve(job);
                    } else {
                        setTimeout(poll, 500);
                    }
                } catch (err) {
                    reject(err);
                }
            };
            poll();
        });
    }

    async function fetchTestFile(url) {
        try {
            const response = await fetch(`/${url}`);
            if (!response.ok) return null;
            const blob = await response.blob();
            return new File([blob], url.split('/').pop(), { type: blob.type });
        } catch {
            return null;
        }
    }

    function showProgress() { progressSection.style.display = 'block'; }
    function hideResult() { resultSection.style.display = 'none'; }
    function showResultSection() { resultSection.style.display = 'block'; }

    function resetProgress() {
        progressLog.innerHTML = '';
        if (progressBar) progressBar.value = 0;
        if (progressStatus) progressStatus.textContent = '';
    }

    function clearEventLog() {
        if (eventLog) eventLog.innerHTML = '';
        eventLogSection.style.display = 'none';
    }

    function updateProgress(percent, message) {
        if (progressBar) progressBar.value = percent;
        if (progressStatus) progressStatus.textContent = message || '';
    }

    function addLog(message) {
        const entry = document.createElement('div');
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        progressLog.appendChild(entry);
        progressLog.scrollTop = progressLog.scrollHeight;
    }

    function addTestResult(name, status, data) {
        testResultsData.push({ name, status, data });
        renderTestResults();
    }

    function updateTestResult(name, status, data) {
        const existing = testResultsData.find(r => r.name === name && r.status === 'running');
        if (existing) {
            existing.status = status;
            existing.data = data;
        } else {
            testResultsData.push({ name, status, data });
        }
        renderTestResults();
    }

    function clearTestResults() {
        testResultsData = [];
        renderTestResults();
    }

    function updateTestSummary() {
        const passed = testResultsData.filter(r => r.status === 'pass').length;
        const failed = testResultsData.filter(r => r.status === 'fail').length;
        testSummary.innerHTML = `
            <div style="flex: 1; min-width: 100px; padding: 0.75rem; background: var(--nui-surface-2); border-radius: 8px; text-align: center;">
                <div style="font-size: 1.5rem; font-weight: 700;">${testResultsData.length}</div>
                <div style="color: var(--nui-text-muted); font-size: 0.85rem;">Total</div>
            </div>
            <div style="flex: 1; min-width: 100px; padding: 0.75rem; background: var(--nui-surface-2); border-radius: 8px; text-align: center;">
                <div style="font-size: 1.5rem; font-weight: 700; color: var(--nui-success, #4caf50);">${passed}</div>
                <div style="color: var(--nui-text-muted); font-size: 0.85rem;">Passed</div>
            </div>
            <div style="flex: 1; min-width: 100px; padding: 0.75rem; background: var(--nui-surface-2); border-radius: 8px; text-align: center;">
                <div style="font-size: 1.5rem; font-weight: 700; color: var(--nui-danger, #f44336);">${failed}</div>
                <div style="color: var(--nui-text-muted); font-size: 0.85rem;">Failed</div>
            </div>
        `;
    }

    function renderTestResults() {
        if (!testResults) return;
        testResults.innerHTML = testResultsData.map(r => {
            const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '⟳';
            const color = r.status === 'pass' ? 'var(--nui-success, #4caf50)' :
                          r.status === 'fail' ? 'var(--nui-danger, #f44336)' :
                          'var(--nui-info, #2196f3)';
            const label = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'RUNNING';

            let detailsHtml = '';
            if (r.status === 'pass' && r.data) {
                const d = r.data;
                const rows = [];
                rows.push(`<span style="color: var(--nui-text-muted);">Time:</span> ${d.elapsed}s`);
                if (d.fileId) rows.push(`<span style="color: var(--nui-text-muted);">fileId:</span> ${d.fileId}`);
                if (d.jobId) rows.push(`<span style="color: var(--nui-text-muted);">jobId:</span> ${d.jobId}`);
                if (d.assetId) rows.push(`<span style="color: var(--nui-text-muted);">assetId:</span> ${d.assetId}`);
                if (d.uploadSize) rows.push(`<span style="color: var(--nui-text-muted);">Upload size:</span> ${formatFileSize(d.uploadSize)}`);
                detailsHtml = `<div style="margin-top: 0.5rem; font-size: 0.85rem; display: flex; gap: 1rem; flex-wrap: wrap;">${rows.map(r => `<span>${r}</span>`).join('')}</div>`;
            } else if (r.status === 'fail' && r.data?.error) {
                detailsHtml = `<div style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--nui-danger, #f44336);">${r.data.error}</div>`;
            }

            return `
                <div style="padding: 0.75rem; border-bottom: 1px solid var(--nui-border, #e0e0e0);">
                    <div style="display: flex; align-items: center; gap: 0.75rem;">
                        <span style="font-size: 1.2rem; color: ${color}; font-weight: 700; min-width: 24px;">${icon}</span>
                        <span style="font-weight: 600; min-width: 160px;">${r.name}</span>
                        <span style="color: ${color}; font-size: 0.8rem; font-weight: 600; min-width: 50px; padding: 0.15rem 0.5rem; border-radius: 4px; background: ${color}15;">${label}</span>
                    </div>
                    ${detailsHtml}
                </div>
            `;
        }).join('');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}
