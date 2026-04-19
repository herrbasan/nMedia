import {
    fetchCapabilities,
    loadPresets, savePreset, deletePreset, getPresetNames,
    connectWebSocket,
    runTask, downloadAsset, getAssetMetadata,
    formatFileSize, formatDuration,
    showProgress, hideProgress, showResult, hideResult,
} from './task-builder.js';

export function initAudioTasksPage(element, nui) {
    console.log('audio tasks init');

    let selectedFile = null;
    let lastAssetId = null;
    let lastBlob = null;
    const blobUrls = [];
    let sourceMetadata = null;
    let discoveredFormats = [];

    function revokeBlobUrls() {
        blobUrls.forEach(url => URL.revokeObjectURL(url));
        blobUrls.length = 0;
    }

    function createTypedBlobUrl(blob, ext) {
        const typeMap = {
            mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
            flac: 'audio/flac', opus: 'audio/opus', pcm: 'audio/wav',
        };
        const type = typeMap[ext] || blob.type || 'application/octet-stream';
        const typedBlob = new Blob([blob], { type });
        const url = URL.createObjectURL(typedBlob);
        blobUrls.push(url);
        return url;
    }

    // Elements
    const fileInfo = element.querySelector('#audio-file-info');
    const inputPath = element.querySelector('#audio-input-path input');
    const probeBtn = element.querySelector('#audio-probe-btn');
    const probeResult = element.querySelector('#audio-probe-result');
    const sampleRateSelect = element.querySelector('#audio-sample-rate select');
    const channelsSelect = element.querySelector('#audio-channels select');
    const formatSelect = element.querySelector('#audio-format');
    const customOptions = element.querySelector('#audio-custom-options textarea');
    const transportModeSelect = element.querySelector('#audio-transport-mode select');
    const presetSelect = element.querySelector('#audio-preset-select select');
    const loadPresetBtn = element.querySelector('#audio-load-preset-btn');
    const savePresetBtn = element.querySelector('#audio-save-preset-btn');
    const deletePresetBtn = element.querySelector('#audio-delete-preset-btn');
    const runTaskBtn = element.querySelector('#audio-run-task-btn');
    const runBatchBtn = element.querySelector('#audio-run-batch-btn');
    const progressSection = element.querySelector('#audio-progress-section');
    const progressBar = element.querySelector('#audio-progress-bar');
    const progressStatus = element.querySelector('#audio-progress-status');
    const progressLog = element.querySelector('#audio-progress-log');
    const resultSection = element.querySelector('#audio-result-section');
    const resultContent = element.querySelector('#audio-result-content');
    const downloadBtn = element.querySelector('#audio-download-btn');
    const batchResultsSection = element.querySelector('#audio-batch-results-section');
    const batchResults = element.querySelector('#audio-batch-results');

    // Init
    fetchCapabilities().then(caps => {
        console.log('[audio-tasks] fetchCapabilities resolved');
        populateAudioFormats(caps);
    }).catch(err => {
        console.error('[audio-tasks] fetchCapabilities failed:', err);
    });
    refreshPresets();

    // File picker
    const selectFileBtn = element.querySelector('#audio-select-file-btn');
    selectFileBtn?.addEventListener('nui-file-selected', (e) => {
        if (e.detail.files.length > 0) handleFile(e.detail.files[0]);
    });

    function handleFile(file) {
        selectedFile = file;
        if (fileInfo) {
            fileInfo.textContent = `${file.name} (${formatFileSize(file.size)})`;
        }
        sourceMetadata = null;
        probeResult.style.display = 'none';
    }

    // Probe
    probeBtn?.addEventListener('nui-click', async () => {
        const path = inputPath?.value;
        if (!selectedFile && !path) {
            nui.components.banner.show({ content: 'Select a file or enter a path first', priority: 'alert', placement: 'bottom', autoClose: 3000 });
            return;
        }

        probeBtn.setLoading(true);
        try {
            let formData;
            if (selectedFile) {
                formData = new FormData();
                formData.append('file', selectedFile);
            } else {
                formData = new FormData();
                formData.append('input_path', path);
            }

            const response = await fetch('http://localhost:3501/v1/audio/probe', {
                method: 'POST',
                body: formData,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();

            sourceMetadata = data.metadata || data;
            probeResult.style.display = '';
            probeResult.innerHTML = `
                <div><strong>Codec:</strong> ${sourceMetadata.codec || 'N/A'}</div>
                <div><strong>Duration:</strong> ${formatDuration(sourceMetadata.duration)}</div>
                <div><strong>Sample Rate:</strong> ${sourceMetadata.sampleRate || 'N/A'} Hz</div>
                <div><strong>Channels:</strong> ${sourceMetadata.channels || 'N/A'}</div>
                <div><strong>Bitrate:</strong> ${sourceMetadata.bitrate ? formatFileSize(sourceMetadata.bitrate / 8) + '/s' : 'N/A'}</div>
            `;
        } catch (e) {
            probeResult.style.display = '';
            probeResult.innerHTML = `<span style="color: var(--nui-danger);">Probe failed: ${e.message}</span>`;
        } finally {
            probeBtn.setLoading(false);
        }
    });

    // Presets
    function refreshPresets() {
        const names = getPresetNames();
        presetSelect.innerHTML = '<option value="">Select preset...</option>';
        names.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            presetSelect.appendChild(opt);
        });
    }

    loadPresetBtn?.addEventListener('nui-click', () => {
        const name = presetSelect.value;
        if (!name) return;
        const preset = loadPresets()[name];
        if (!preset) return;
        if (preset.sample_rate) sampleRateSelect.value = preset.sample_rate;
        if (preset.channels) channelsSelect.value = preset.channels;
        if (preset.format) formatSelect.value = preset.format;
        nui.components.banner.show({ content: `Loaded preset: ${name}`, priority: 'info', placement: 'bottom', autoClose: 2000 });
    });

    savePresetBtn?.addEventListener('nui-click', () => {
        const name = prompt('Preset name:');
        if (!name) return;
        savePreset(name, getOptions());
        refreshPresets();
        presetSelect.value = name;
        nui.components.banner.show({ content: `Saved preset: ${name}`, priority: 'info', placement: 'bottom', autoClose: 2000 });
    });

    deletePresetBtn?.addEventListener('nui-click', () => {
        const name = presetSelect.value;
        if (!name) return;
        deletePreset(name);
        refreshPresets();
        nui.components.banner.show({ content: `Deleted preset: ${name}`, priority: 'alert', placement: 'bottom', autoClose: 2000 });
    });

    // Run task
    runTaskBtn?.addEventListener('nui-click', async () => {
        if (!selectedFile && !inputPath?.value) {
            nui.components.banner.show({ content: 'Select a file or enter a path first', priority: 'alert', placement: 'bottom', autoClose: 3000 });
            return;
        }

        const options = getOptions();
        const transportMode = transportModeSelect.value;
        const startTime = performance.now();

        runTaskBtn.setLoading(true);
        hideResult(resultSection);
        showProgress(progressSection, progressBar, progressStatus, progressLog, 0, 'Starting...');

        try {
            // Connect WS if needed
            if (transportMode === 'websocket') {
                await connectWebSocket((msg) => {
                    showProgress(progressSection, progressBar, progressStatus, progressLog, msg.percent || 0, msg.message || 'Processing...');
                });
            }

            const result = await runTask(
                selectedFile,
                inputPath?.value,
                'audio',
                options,
                transportMode,
                (data) => {
                    showProgress(progressSection, progressBar, progressStatus, progressLog, data.percent || 0, data.message || 'Processing...');
                },
                (data) => {
                    lastAssetId = data.assetId;
                },
                (data) => {
                    throw new Error(data.error || 'Processing failed');
                }
            );

            hideProgress(progressSection);
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

            // Get metadata and download
            const metadata = await getAssetMetadata(lastAssetId);
            const blob = await downloadAsset(lastAssetId, `audio-${options.format || 'output'}.${options.format || 'mp3'}`);
            lastBlob = blob;
            revokeBlobUrls();

            showResult(resultSection, resultContent, `
                <div style="margin-bottom: 1rem;">
                    <strong>Asset ID:</strong> ${lastAssetId}<br>
                    <strong>Processing Time:</strong> ${elapsed}s<br>
                    <strong>Output Size:</strong> ${formatFileSize(blob.size)}<br>
                    <strong>Options:</strong> ${JSON.stringify(options)}
                </div>
                ${metadata ? `<details><summary>Metadata</summary><pre style="font-size: 0.8rem; overflow-x: auto;">${JSON.stringify(metadata, null, 2)}</pre></details>` : ''}
                <audio controls preload="metadata" src="${createTypedBlobUrl(blob, options.format || 'mp3')}" style="width: 100%; margin-top: 1rem;"></audio>
            `);
            downloadBtn.style.display = '';
        } catch (e) {
            hideProgress(progressSection);
            showResult(resultSection, resultContent, `<p style="color: var(--nui-danger);">Error: ${e.message}</p>`);
        } finally {
            runTaskBtn.setLoading(false);
        }
    });

    // Batch run
    runBatchBtn?.addEventListener('nui-click', async () => {
        if (!selectedFile && !inputPath?.value) {
            nui.components.banner.show({ content: 'Select a file or enter a path first', priority: 'alert', placement: 'bottom', autoClose: 3000 });
            return;
        }

        runBatchBtn.setLoading(true);
        batchResultsSection.style.display = '';
        batchResults.innerHTML = '<p>Running batch tests...</p>';

        const formats = discoveredFormats.length > 0 ? discoveredFormats : ['mp3', 'wav', 'ogg', 'm4a'];
        const sampleRates = [16000, 44100];
        const results = [];

        for (const fmt of formats) {
            for (const sr of sampleRates) {
                const options = { sample_rate: sr, channels: 1, format: fmt };
                const startTime = performance.now();
                try {
                    const result = await runTask(
                        selectedFile,
                        inputPath?.value,
                        'audio',
                        options,
                        'polling',
                        (data) => {},
                        (data) => { lastAssetId = data.assetId; },
                        (data) => { throw new Error(data.error); }
                    );
                    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
                    const metadata = await getAssetMetadata(lastAssetId);
                    results.push({ options, elapsed, success: true, size: metadata?.size || 0 });
                } catch (e) {
                    results.push({ options, elapsed: ((performance.now() - startTime) / 1000).toFixed(2), success: false, error: e.message });
                }
            }
        }

        batchResults.innerHTML = `
            <table style="width: 100%; font-size: 0.85rem; border-collapse: collapse;">
                <thead>
                    <tr style="border-bottom: 1px solid var(--nui-border);">
                        <th style="text-align: left; padding: 0.5rem;">Format</th>
                        <th style="text-align: left; padding: 0.5rem;">Sample Rate</th>
                        <th style="text-align: left; padding: 0.5rem;">Time</th>
                        <th style="text-align: left; padding: 0.5rem;">Size</th>
                        <th style="text-align: left; padding: 0.5rem;">Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${results.map(r => `
                        <tr style="border-bottom: 1px solid var(--nui-border);">
                            <td style="padding: 0.5rem;">${r.options.format}</td>
                            <td style="padding: 0.5rem;">${r.options.sample_rate} Hz</td>
                            <td style="padding: 0.5rem;">${r.elapsed}s</td>
                            <td style="padding: 0.5rem;">${r.success ? formatFileSize(r.size) : '-'}</td>
                            <td style="padding: 0.5rem; color: ${r.success ? 'var(--nui-success)' : 'var(--nui-danger)'};">${r.success ? 'OK' : r.error}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        runBatchBtn.setLoading(false);
    });

    // Download
    downloadBtn?.addEventListener('nui-click', () => {
        if (lastBlob) {
            const a = document.createElement('a');
            a.href = createTypedBlobUrl(lastBlob, opts.format || 'mp3');
            a.download = `audio-output.mp3`;
            a.click();
        }
    });

    function getOptions() {
        const options = {};
        if (sampleRateSelect.value) {
            options.sample_rate = sampleRateSelect.value === 'source' ? 'source' : parseInt(sampleRateSelect.value);
        }
        if (channelsSelect.value) {
            options.channels = channelsSelect.value === 'source' ? 'source' : parseInt(channelsSelect.value);
        }
        const fmt = formatSelect.getValue?.() || formatSelect.value;
        if (fmt) options.format = fmt;

        // Custom JSON override
        if (customOptions.value.trim()) {
            try {
                Object.assign(options, JSON.parse(customOptions.value));
            } catch (e) {
                nui.components.banner.show({ content: 'Invalid custom JSON: ' + e.message, priority: 'alert', placement: 'bottom', autoClose: 3000 });
            }
        }
        return options;
    }

    function populateAudioFormats(caps) {
        console.log('[populateAudioFormats] caps keys:', Object.keys(caps));
        const nVideoCaps = caps?.nVideo || caps;
        const allFormats = nVideoCaps?.formats?.all || [];
        console.log('[populateAudioFormats] allFormats count:', allFormats.length);
        const audioExts = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus', 'wma', 'ac3', 'eac3', 'dts', 'pcm', 'aiff', 'au', 'wv']);
        const muxable = allFormats.filter(f => f.canMux && f.extensions?.some(e => audioExts.has(e.toLowerCase())));
        const seen = new Set();
        const formats = [];
        muxable.forEach(f => {
            f.extensions.forEach(e => {
                const ext = e.toLowerCase();
                if (audioExts.has(ext) && !seen.has(ext)) {
                    seen.add(ext);
                    formats.push(ext);
                }
            });
        });
        // Fallback if capabilities empty
        if (formats.length === 0) formats.push('mp3', 'wav', 'ogg', 'm4a');
        console.log('[populateAudioFormats] discovered formats:', formats);
        discoveredFormats = formats;
        formatSelect.setItems(formats.map(fmt => ({ value: fmt, label: fmt.toUpperCase() })));
        formatSelect.setValue('mp3');
    }
}
