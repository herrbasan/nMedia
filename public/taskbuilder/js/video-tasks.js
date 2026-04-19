import {
    fetchCapabilities,
    loadPresets, savePreset, deletePreset, getPresetNames,
    runTask, downloadAsset, getAssetMetadata,
    formatFileSize, formatDuration,
    showProgress, hideProgress, showResult, hideResult,
} from './task-builder.js';

export function initVideoTasksPage(element, nui) {
    console.log('video tasks init');

    let selectedFile = null;
    let lastAssetId = null;
    let lastBlob = null;

    // Elements
    const fileInfo = element.querySelector('#video-file-info');
    const inputPath = element.querySelector('#video-input-path input');
    const probeBtn = element.querySelector('#video-probe-btn');
    const probeResult = element.querySelector('#video-probe-result');
    const modeTabs = element.querySelector('#video-mode-tabs');

    // Extract audio
    const audioFormatSelect = element.querySelector('#video-audio-format-select');
    const audioCodecSelect = element.querySelector('#video-audio-codec-select');
    const audioSampleRateSelect = element.querySelector('#video-audio-samplerate select');
    const kfFpsSlider = element.querySelector('#video-kf-fps');
    const kfFpsValue = element.querySelector('#video-kf-fps-value');
    const kfMaxDimSlider = element.querySelector('#video-kf-maxdim');
    const kfMaxDimValue = element.querySelector('#video-kf-maxdim-value');
    const kfFormatSelect = element.querySelector('#video-kf-format select');
    const containerSelect = element.querySelector('#video-transcode-container-select');
    const vcodecSelect = element.querySelector('#video-transcode-vcodec-select');
    const acodecSelect = element.querySelector('#video-transcode-acodec-select');
    const hwaccelSelect = element.querySelector('#video-transcode-hwaccel-select');
    const crfSlider = element.querySelector('#video-transcode-crf');
    const crfValue = element.querySelector('#video-transcode-crf-value');
    const presetSelect = element.querySelector('#video-transcode-preset select');
    const widthInput = element.querySelector('#video-transcode-width');
    const heightInput = element.querySelector('#video-transcode-height');
    const filtersTextarea = element.querySelector('#video-transcode-filters textarea');
    const recommendedDiv = element.querySelector('#video-transcode-recommended');

    let activeModeTab = 0;

    // Common
    const transportModeSelect = element.querySelector('#video-transport-mode select');
    const presetSelectEl = element.querySelector('#video-preset-select select');
    const loadPresetBtn = element.querySelector('#video-load-preset-btn');
    const savePresetBtn = element.querySelector('#video-save-preset-btn');
    const deletePresetBtn = element.querySelector('#video-delete-preset-btn');
    const runTaskBtn = element.querySelector('#video-run-task-btn');
    const runBatchBtn = element.querySelector('#video-run-batch-btn');
    const progressSection = element.querySelector('#video-progress-section');
    const progressBar = element.querySelector('#video-progress-bar');
    const progressStatus = element.querySelector('#video-progress-status');
    const progressLog = element.querySelector('#video-progress-log');
    const resultSection = element.querySelector('#video-result-section');
    const resultContent = element.querySelector('#video-result-content');
    const downloadBtn = element.querySelector('#video-download-btn');
    const batchResultsSection = element.querySelector('#video-batch-results-section');
    const batchResults = element.querySelector('#video-batch-results');

    // Init
    fetchCapabilities().then(caps => {
        populateVideoOptions(caps);
    });
    refreshPresets();

    // Slider updates
    kfFpsSlider?.addEventListener('input', () => { kfFpsValue.textContent = kfFpsSlider.value; });
    kfMaxDimSlider?.addEventListener('input', () => { kfMaxDimValue.textContent = kfMaxDimSlider.value; });
    crfSlider?.addEventListener('input', () => { crfValue.textContent = crfSlider.value; });

    // Mode tab tracking
    modeTabs?.addEventListener('nui-tab-change', (e) => {
        const tabButtons = modeTabs.querySelectorAll('[role="tab"]');
        activeModeTab = Array.from(tabButtons).indexOf(e.detail.tab);
    });

    // File picker
    const selectFileBtn = element.querySelector('#video-select-file-btn');
    selectFileBtn?.addEventListener('nui-file-selected', (e) => {
        if (e.detail.files.length > 0) handleFile(e.detail.files[0]);
    });

    function handleFile(file) {
        selectedFile = file;
        if (fileInfo) fileInfo.textContent = `${file.name} (${formatFileSize(file.size)})`;
    }

    // Probe
    probeBtn?.addEventListener('nui-click', async () => {
        nui.components.banner.show({ content: 'Video probe: Use file path input or check capabilities for codec info', priority: 'info', placement: 'bottom', autoClose: 4000 });
    });

    // Presets
    function refreshPresets() {
        const names = getPresetNames();
        presetSelectEl.innerHTML = '<option value="">Select preset...</option>';
        names.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            presetSelectEl.appendChild(opt);
        });
    }

    loadPresetBtn?.addEventListener('nui-click', () => {
        const name = presetSelectEl.value;
        if (!name) return;
        const preset = loadPresets()[name];
        if (!preset) return;
        // Apply preset values to current mode
        nui.components.banner.show({ content: `Loaded preset: ${name}`, priority: 'info', placement: 'bottom', autoClose: 2000 });
    });

    savePresetBtn?.addEventListener('nui-click', () => {
        const name = prompt('Preset name:');
        if (!name) return;
        savePreset(name, getOptions());
        refreshPresets();
        presetSelectEl.value = name;
        nui.components.banner.show({ content: `Saved preset: ${name}`, priority: 'info', placement: 'bottom', autoClose: 2000 });
    });

    deletePresetBtn?.addEventListener('nui-click', () => {
        const name = presetSelectEl.value;
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
            const result = await runTask(
                selectedFile, inputPath?.value, 'video', options, transportMode,
                (data) => showProgress(progressSection, progressBar, progressStatus, progressLog, data.percent || 0, data.message || 'Processing...'),
                (data) => { lastAssetId = data.assetId; },
                (data) => { throw new Error(data.error || 'Processing failed'); }
            );

            hideProgress(progressSection);
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

            const metadata = await getAssetMetadata(lastAssetId);
            const ext = options.mode === 'extract_audio' ? (options.format || 'mp3') :
                        options.mode === 'extract_keyframes' ? 'jpg' :
                        (containerSelect?.value || 'mp4');
            const blob = await downloadAsset(lastAssetId, `video-${options.mode || 'output'}.${ext}`);
            lastBlob = blob;

            let resultHtml = `
                <div style="margin-bottom: 1rem;">
                    <strong>Asset ID:</strong> ${lastAssetId}<br>
                    <strong>Mode:</strong> ${options.mode}<br>
                    <strong>Processing Time:</strong> ${elapsed}s<br>
                    <strong>Output Size:</strong> ${formatFileSize(blob.size)}<br>
                    <strong>Options:</strong> ${JSON.stringify(options)}
                </div>
            `;

            if (options.mode === 'extract_audio') {
                resultHtml += `<audio controls src="${URL.createObjectURL(blob)}" style="width: 100%; margin-top: 1rem;"></audio>`;
            } else if (options.mode === 'transcode' && ext === 'mp4') {
                resultHtml += `<video controls src="${URL.createObjectURL(blob)}" style="width: 100%; max-height: 400px; margin-top: 1rem;"></video>`;
            }

            if (metadata) {
                resultHtml += `<details style="margin-top: 1rem;"><summary>Metadata</summary><pre style="font-size: 0.8rem; overflow-x: auto;">${JSON.stringify(metadata, null, 2)}</pre></details>`;
            }

            showResult(resultSection, resultContent, resultHtml);
            downloadBtn.style.display = '';
        } catch (e) {
            hideProgress(progressSection);
            showResult(resultSection, resultContent, `<p style="color: var(--nui-danger);">Error: ${e.message}</p>`);
        } finally {
            runTaskBtn.setLoading(false);
        }
    });

    // Run all modes batch
    runBatchBtn?.addEventListener('nui-click', async () => {
        if (!selectedFile && !inputPath?.value) {
            nui.components.banner.show({ content: 'Select a file or enter a path first', priority: 'alert', placement: 'bottom', autoClose: 3000 });
            return;
        }

        runBatchBtn.setLoading(true);
        batchResultsSection.style.display = '';
        batchResults.innerHTML = '<p>Running all modes...</p>';

        const modes = [
            { mode: 'extract_audio', format: 'mp3' },
            { mode: 'extract_keyframes', fps: 1, max_dimension: 512 },
            { mode: 'transcode', video_codec: 'libx264', crf: 28, preset: 'fast' },
        ];
        const results = [];

        for (const modeOpts of modes) {
            const startTime = performance.now();
            try {
                await runTask(
                    selectedFile, inputPath?.value, 'video', modeOpts, 'polling',
                    () => {},
                    (data) => { lastAssetId = data.assetId; },
                    (data) => { throw new Error(data.error); }
                );
                const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
                const metadata = await getAssetMetadata(lastAssetId);
                results.push({ mode: modeOpts.mode, elapsed, success: true, size: metadata?.size || 0 });
            } catch (e) {
                results.push({ mode: modeOpts.mode, elapsed: ((performance.now() - startTime) / 1000).toFixed(2), success: false, error: e.message });
            }
        }

        batchResults.innerHTML = `
            <table style="width: 100%; font-size: 0.85rem; border-collapse: collapse;">
                <thead>
                    <tr style="border-bottom: 1px solid var(--nui-border);">
                        <th style="text-align: left; padding: 0.5rem;">Mode</th>
                        <th style="text-align: left; padding: 0.5rem;">Time</th>
                        <th style="text-align: left; padding: 0.5rem;">Size</th>
                        <th style="text-align: left; padding: 0.5rem;">Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${results.map(r => `
                        <tr style="border-bottom: 1px solid var(--nui-border);">
                            <td style="padding: 0.5rem;">${r.mode}</td>
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
            a.href = URL.createObjectURL(lastBlob);
            a.download = `video-output.mp4`;
            a.click();
        }
    });

    function getOptions() {
        const modes = ['extract_audio', 'extract_keyframes', 'transcode'];
        const mode = modes[activeModeTab] || 'extract_audio';

        const options = { mode };

        if (mode === 'extract_audio') {
            if (audioFormatSelect.value) options.format = audioFormatSelect.value;
            if (audioCodecSelect.value) options.audio_codec = audioCodecSelect.value;
            if (audioSampleRateSelect.value) options.sample_rate = parseInt(audioSampleRateSelect.value);
        } else if (mode === 'extract_keyframes') {
            options.fps = parseInt(kfFpsSlider.value);
            options.max_dimension = parseInt(kfMaxDimSlider.value);
            if (kfFormatSelect.value) options.frame_format = kfFormatSelect.value;
        } else if (mode === 'transcode') {
            if (containerSelect.value) options.output_format = containerSelect.value;
            if (vcodecSelect.value) options.video_codec = vcodecSelect.value;
            if (acodecSelect.value) options.audio_codec = acodecSelect.value;
            if (hwaccelSelect.value) options.hwaccel = hwaccelSelect.value;
            options.crf = parseInt(crfSlider.value);
            if (presetSelect.value) options.preset = presetSelect.value;
            if (widthInput.value) options.width = parseInt(widthInput.value);
            if (heightInput.value) options.height = parseInt(heightInput.value);
            if (filtersTextarea.value) options.filters = filtersTextarea.value;
        }

        return options;
    }

    function populateVideoOptions(caps) {
        const nVideoCaps = caps?.nVideo || caps;
        const common = nVideoCaps?.commonCodecs || {};

        // Audio codecs
        const audioEncoders = common.encoders?.audio || [];
        audioCodecSelect.innerHTML = '<option value="">Auto</option>';
        audioEncoders.forEach(codec => {
            const opt = document.createElement('option');
            opt.value = codec.name;
            opt.textContent = codec.longName || codec.name;
            audioCodecSelect.appendChild(opt);
        });

        // Video codecs (CPU)
        const cpuEncoders = common.encoders?.video?.cpu || [];
        vcodecSelect.innerHTML = '';
        cpuEncoders.forEach(codec => {
            const opt = document.createElement('option');
            opt.value = codec.name;
            opt.textContent = codec.longName || codec.name;
            vcodecSelect.appendChild(opt);
        });

        // Audio codecs for transcode
        acodecSelect.innerHTML = '';
        audioEncoders.forEach(codec => {
            const opt = document.createElement('option');
            opt.value = codec.name;
            opt.textContent = codec.longName || codec.name;
            acodecSelect.appendChild(opt);
        });

        // HWAccel
        const hwaccels = common.videoEncodersByHwaccel || {};
        hwaccelSelect.innerHTML = '<option value="">Auto (CPU)</option>';
        Object.keys(hwaccels).forEach(hw => {
            if (hw !== 'cpu') {
                const opt = document.createElement('option');
                opt.value = hw;
                opt.textContent = hw.toUpperCase();
                hwaccelSelect.appendChild(opt);
            }
        });

        // Recommended
        if (common.recommended) {
            const rec = common.recommended;
            recommendedDiv.innerHTML = `<strong>Recommended:</strong> ${Object.entries(rec).map(([k, v]) => `${k}: ${v.video || ''}/${v.audio || ''}`).join(' | ')}`;
        }
    }
}
