const API_BASE = 'http://localhost:3500';

export function initTransportTestsPage(element, nui) {
    console.log('transport tests init');

    let selectedFile = null;
    let testResultsData = [];

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

    filePicker?.addEventListener('nui-file-selected', (e) => {
        if (e.detail.files.length > 0) {
            selectedFile = e.detail.files[0];
            fileInfo.innerHTML = `<strong>${selectedFile.name}</strong> — ${formatFileSize(selectedFile.size)} — ${selectedFile.type || 'Unknown'}`;
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

    function getProcessingOptions() {
        const processor = processorSelect.value;
        const options = {};

        if (processor === 'audio') {
            options.sample_rate = parseInt(element.querySelector('#transport-audio-samplerate select')?.value || '16000');
            options.format = element.querySelector('#transport-audio-format select')?.value || 'mp3';
            options.channels = 1;
        } else if (processor === 'video') {
            options.mode = element.querySelector('#transport-video-mode select')?.value || 'extract_audio';
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

        const processBody = {
            fileId,
            processor,
            options,
        };

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
        addLog(`Job created: ${jobId}, status: ${processData.status}`);

        await pollJobProgress(jobId);
    }

    async function processWithPath(inputPath, processor, options) {
        addLog(`Step 1: Submitting path-based job...`);
        updateProgress(10, 'Submitting job...');

        const processBody = {
            input_path: inputPath,
            processor,
            options,
        };

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
        addLog(`Job created: ${jobId}, status: ${processData.status}`);

        await pollJobProgress(jobId);
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
        if (!job.assetId) {
            resultContent.innerHTML = `<p>Job completed but no asset was produced.</p>`;
            showResultSection();
            return;
        }

        const assetResponse = await fetch(`${API_BASE}/v1/assets/${job.assetId}/metadata`);
        const assetMeta = assetResponse.ok ? await assetResponse.json() : null;

        let html = `<div style="margin-bottom: 1rem;">`;
        html += `<p><strong>Job ID:</strong> ${job.jobId}</p>`;
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

    function formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}
