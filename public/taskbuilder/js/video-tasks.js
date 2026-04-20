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
    const blobUrls = [];

    function revokeBlobUrls() {
        blobUrls.forEach(url => URL.revokeObjectURL(url));
        blobUrls.length = 0;
    }

    function createTypedBlobUrl(blob, ext) {
        const typeMap = {
            mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
            avi: 'video/x-msvideo', ts: 'video/mp2t', flv: 'video/x-flv', '3gp': 'video/3gpp',
            ogv: 'video/ogg', wmv: 'video/x-ms-wmv',
            mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
            flac: 'audio/flac', opus: 'audio/opus',
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
            webp: 'image/webp', avif: 'image/avif',
        };
        const type = typeMap[ext] || blob.type || 'application/octet-stream';
        const typedBlob = new Blob([blob], { type });
        const url = URL.createObjectURL(typedBlob);
        blobUrls.push(url);
        return url;
    }

    // Elements
    const fileInfo = element.querySelector('#video-file-info');
    const inputPath = element.querySelector('#video-input-path input');
    const probeBtn = element.querySelector('#video-probe-btn');
    const probeResult = element.querySelector('#video-probe-result');
    const modeTabs = element.querySelector('#video-mode-tabs');

    // Extract audio
    const audioFormatSelect = element.querySelector('#video-audio-format');
    const audioCodecSelect = element.querySelector('#video-audio-codec');
    const audioSampleRateSelect = element.querySelector('#video-audio-samplerate select');
    const kfFpsSlider = element.querySelector('#video-kf-fps');
    const kfFpsValue = element.querySelector('#video-kf-fps-value');
    const kfMaxDimSlider = element.querySelector('#video-kf-maxdim');
    const kfMaxDimValue = element.querySelector('#video-kf-maxdim-value');
    const kfFormatSelect = element.querySelector('#video-kf-format select');
    const containerSelect = element.querySelector('#video-transcode-container');
    const vcodecSelect = element.querySelector('#video-transcode-vcodec');
    const acodecSelect = element.querySelector('#video-transcode-acodec');
    const crfSlider = element.querySelector('#video-transcode-crf');
    const crfValue = element.querySelector('#video-transcode-crf-value');
    const presetSelect = element.querySelector('#video-transcode-preset select');
    const widthInput = element.querySelector('#video-transcode-width');
    const heightInput = element.querySelector('#video-transcode-height');
    const filtersTextarea = element.querySelector('#video-transcode-filters textarea');
    const recommendedDiv = element.querySelector('#video-transcode-recommended');

    // CLI
    const cliCommandTextarea = element.querySelector('#video-cli-command textarea');
    const cliFormatSelect = element.querySelector('#video-cli-format');
    const cliPreview = element.querySelector('#video-cli-preview');
    const cliPresetSelect = element.querySelector('#video-cli-preset-select');
    const cliLoadPresetBtn = element.querySelector('#video-cli-load-preset-btn');

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
        console.log('[video-tasks] fetchCapabilities resolved');
        populateVideoOptions(caps);
    }).catch(err => {
        console.error('[video-tasks] fetchCapabilities failed:', err);
    });
    refreshPresets();

    // Slider updates
    kfFpsSlider?.addEventListener('input', () => { kfFpsValue.textContent = kfFpsSlider.value; });
    kfMaxDimSlider?.addEventListener('input', () => { kfMaxDimValue.textContent = kfMaxDimSlider.value; });
    crfSlider?.addEventListener('input', () => { crfValue.textContent = crfSlider.value; });

    // CLI events
    cliCommandTextarea?.addEventListener('input', updateCliPreview);
    cliLoadPresetBtn?.addEventListener('nui-click', () => {
        const preset = cliPresetSelect.getValue?.() || cliPresetSelect.value;
        if (preset) {
            cliCommandTextarea.value = preset;
            updateCliPreview();
        }
    });

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
        const path = inputPath?.value;
        if (!selectedFile && !path) {
            nui.components.banner.show({ content: 'Select a file or enter a path first', priority: 'alert', placement: 'bottom', autoClose: 3000 });
            return;
        }

        probeBtn.setLoading(true);
        let formData;
        if (selectedFile) {
            formData = new FormData();
            formData.append('file', selectedFile);
        } else {
            formData = new FormData();
            formData.append('input_path', path);
        }

        const response = await fetch('http://localhost:3501/v1/video/probe', {
            method: 'POST',
            body: formData,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        const meta = data.metadata || data;
        probeResult.style.display = '';
        probeResult.innerHTML = `
            <div><strong>Format:</strong> ${meta.format || 'N/A'}</div>
            <div><strong>Duration:</strong> ${formatDuration(meta.duration)}</div>
            <div><strong>Bitrate:</strong> ${meta.bitrate ? formatFileSize(meta.bitrate / 8) + '/s' : 'N/A'}</div>
            ${meta.video ? `
            <div style="margin-top: 0.5rem; border-top: 1px solid var(--nui-border); padding-top: 0.5rem;">
                <strong>Video:</strong> ${meta.video.codec} ${meta.video.width}x${meta.video.height} @ ${meta.video.fps?.toFixed(2) || '?'} fps
            </div>` : ''}
            ${meta.audio ? `
            <div style="margin-top: 0.5rem; border-top: 1px solid var(--nui-border); padding-top: 0.5rem;">
                <strong>Audio:</strong> ${meta.audio.codec} ${meta.audio.sampleRate || '?'} Hz, ${meta.audio.channels || '?'} ch
            </div>` : ''}
        `;
        probeBtn.setLoading(false);
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
                    options.output_format || 'mp4';
        const blob = await downloadAsset(lastAssetId, `video-${options.mode || 'output'}.${ext}`);
        lastBlob = blob;
        revokeBlobUrls();

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
            resultHtml += `<audio controls preload="metadata" src="${createTypedBlobUrl(blob, ext)}" style="width: 100%; margin-top: 1rem;"></audio>`;
        } else if ((options.mode === 'transcode' || options.mode === 'cli') && (ext === 'mp4' || ext === 'webm' || ext === 'mov')) {
            resultHtml += `<video controls preload="metadata" src="${createTypedBlobUrl(blob, ext)}" style="width: 100%; max-height: 400px; margin-top: 1rem;"></video>`;
        }

        if (metadata) {
            resultHtml += `<details style="margin-top: 1rem;"><summary>Metadata</summary><pre style="font-size: 0.8rem; overflow-x: auto;">${JSON.stringify(metadata, null, 2)}</pre></details>`;
        }

        showResult(resultSection, resultContent, resultHtml);
        downloadBtn.style.display = '';
        runTaskBtn.setLoading(false);
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
            const opts = getOptions();
            const ext = opts.output_format || opts.format || 'mp4';
            const a = document.createElement('a');
            a.href = createTypedBlobUrl(lastBlob, ext);
            a.download = `video-output.${ext}`;
            a.click();
        }
    });

    function getOptions() {
        const modes = ['extract_audio', 'extract_keyframes', 'transcode', 'cli'];
        const mode = modes[activeModeTab] || 'extract_audio';

        const options = { mode };

        if (mode === 'extract_audio') {
            const fmt = audioFormatSelect.getValue?.() || audioFormatSelect.value;
            if (fmt) options.format = fmt;
            const ac = audioCodecSelect.getValue?.() || audioCodecSelect.value;
            if (ac) options.audio_codec = ac;
            if (audioSampleRateSelect.value) {
                options.sample_rate = audioSampleRateSelect.value === 'source' ? 'source' : parseInt(audioSampleRateSelect.value);
            }
        } else if (mode === 'extract_keyframes') {
            options.fps = parseInt(kfFpsSlider.value);
            options.max_dimension = parseInt(kfMaxDimSlider.value);
            if (kfFormatSelect.value) options.frame_format = kfFormatSelect.value;
        } else if (mode === 'transcode') {
            const cont = containerSelect.getValue?.() || containerSelect.value;
            if (cont) options.output_format = cont;
            const vc = vcodecSelect.getValue?.() || vcodecSelect.value;
            if (vc) options.video_codec = vc;
            const ac = acodecSelect.getValue?.() || acodecSelect.value;
            if (ac) options.audio_codec = ac;
            options.crf = parseInt(crfSlider.value);
            if (presetSelect.value) options.preset = presetSelect.value;
            if (widthInput.value) options.width = parseInt(widthInput.value);
            if (heightInput.value) options.height = parseInt(heightInput.value);
            if (filtersTextarea.value) options.filters = filtersTextarea.value;
        } else if (mode === 'cli') {
            const cont = cliFormatSelect.getValue?.() || cliFormatSelect.value;
            if (cont) options.output_format = cont;
            const cli = cliCommandTextarea.value.trim();
            if (cli) {
                const parsed = parseCliToNVideo(cli);
                options.video_codec = parsed.videoCodec;
                options.audio_codec = parsed.audioCodec;
                options.preset = parsed.preset;
                options.crf = parsed.crf;
                options.width = parsed.width;
                options.height = parsed.height;
                options.fps = parsed.fps;
                options.filters = parsed.filters;
                if (parsed.videoOptions) options.videoOptions = parsed.videoOptions;
                if (parsed.audioOptions) options.audioOptions = parsed.audioOptions;
                if (parsed.noAudio) options.no_audio = true;
                if (parsed.noVideo) options.no_video = true;
                if (parsed.hwaccel) options.hwaccel = parsed.hwaccel;
                // Auto-infer CUDA hwaccel for nvenc codecs if not explicitly set
                if (!options.hwaccel && parsed.videoCodec && parsed.videoCodec.includes('nvenc')) {
                    options.hwaccel = 'cuda';
                }
            }
        }

        return options;
    }

    function parseCliToNVideo(cli) {
        const result = {
                videoCodec: null, audioCodec: null, preset: null, crf: null,
                width: null, height: null, fps: null, filters: null,
                videoOptions: null, audioOptions: null, noAudio: false, noVideo: false,
                hwaccel: null,
            };
        if (!cli) return result;

        // Normalize: split by spaces but handle quoted strings
        const tokens = cli.match(/(?:"[^"]*"|'[^']*'|\S+)/g) || [];
        const args = tokens.map(t => t.replace(/^["']|["']$/g, ''));

        for (let i = 0; i < args.length; i++) {
            const flag = args[i];
            const next = args[i + 1];
            const hasNext = next !== undefined && !next.startsWith('-');

            switch (flag) {
                case '-c:v':
                case '-vcodec':
                case '-codec:v':
                    if (hasNext) { result.videoCodec = next; i++; }
                    break;
                case '-c:a':
                case '-acodec':
                case '-codec:a':
                    if (hasNext) { result.audioCodec = next; i++; }
                    break;
                case '-preset':
                case '-preset:v':
                    if (hasNext) {
                        result.preset = next;
                        (result.videoOptions ||= {})['preset'] = next;
                        i++;
                    }
                    break;
                case '-crf':
                case '-crf:v':
                    if (hasNext) {
                        result.crf = parseInt(next);
                        (result.videoOptions ||= {})['crf'] = next;
                        i++;
                    }
                    break;
                case '-qp':
                case '-qp:v':
                case '-cq':
                case '-cq:v':
                    if (hasNext) {
                        if (!result.crf) result.crf = parseInt(next);
                        (result.videoOptions ||= {})[flag.replace(/^-|:v$/g, '')] = next;
                        i++;
                    }
                    break;
                case '-b:v':
                case '-vb':
                case '-video_bitrate':
                    if (hasNext) {
                        const val = next.replace(/k$/i, '000').replace(/m$/i, '000000');
                        (result.videoOptions ||= {})['b'] = val;
                        i++;
                    }
                    break;
                case '-b:a':
                case '-ab':
                case '-audio_bitrate':
                    if (hasNext) {
                        const val = next.replace(/k$/i, '000').replace(/m$/i, '000000');
                        (result.audioOptions ||= {})['b'] = val;
                        i++;
                    }
                    break;
                case '-ar':
                    if (hasNext) {
                        (result.audioOptions ||= {})['sample_rate'] = next;
                        i++;
                    }
                    break;
                case '-ac':
                    if (hasNext) {
                        (result.audioOptions ||= {})['ch_layout'] = next;
                        i++;
                    }
                    break;
                case '-r':
                case '-fps':
                    if (hasNext) { result.fps = parseFloat(next); i++; }
                    break;
                case '-s':
                case '-video_size':
                    if (hasNext) {
                        const [w, h] = next.split(/[x:]/);
                        if (w && h) { result.width = parseInt(w); result.height = parseInt(h); }
                        i++;
                    }
                    break;
                case '-vf':
                case '-filter:v':
                    if (hasNext) { result.filters = next; i++; }
                    break;
                case '-af':
                case '-filter:a':
                    if (hasNext) {
                        (result.audioOptions ||= {}).filters = next;
                        i++;
                    }
                    break;
                case '-pix_fmt':
                case '-pix_fmt:v':
                    if (hasNext) {
                        (result.videoOptions ||= {})['pix_fmt'] = next;
                        i++;
                    }
                    break;
                case '-g':
                    if (hasNext) {
                        (result.videoOptions ||= {}).g = next;
                        i++;
                    }
                    break;
                case '-threads':
                    if (hasNext) {
                        (result.videoOptions ||= {}).threads = next;
                        i++;
                    }
                    break;
                case '-hwaccel':
                    if (hasNext) {
                        const map = { nvdec: 'cuda', cuda: 'cuda', qsv: 'qsv', vaapi: 'vaapi', d3d11va: 'd3d11va' };
                        result.hwaccel = map[next] || next;
                        i++;
                    }
                    break;
                case '-an':
                    result.noAudio = true;
                    break;
                case '-vn':
                    result.noVideo = true;
                    break;
                case '-itsoffset':
                    if (hasNext) { i++; } // skip for now
                    break;
                default:
                    // Handle arbitrary codec-specific options like -rc, -tune, -cpu-used, -row-mt, -tiles
                    if (flag.startsWith('-') && hasNext) {
                        const optName = flag.replace(/^-+/, '').replace(/:v$/, '');
                        const isVideo = flag.endsWith(':v');
                        const isAudio = flag.endsWith(':a');
                        if (isVideo || (!isAudio && !result.audioCodec)) {
                            (result.videoOptions ||= {})[optName] = next;
                        } else if (isAudio) {
                            (result.audioOptions ||= {})[optName] = next;
                        } else {
                            // Default to video options for unknown flags
                            (result.videoOptions ||= {})[optName] = next;
                        }
                        i++;
                    }
                    break;
            }
        }

        return result;
    }

    function updateCliPreview() {
        const cli = cliCommandTextarea.value.trim();
        const parsed = parseCliToNVideo(cli);
        const nvideo = {};
        if (parsed.videoCodec) nvideo.video = { codec: parsed.videoCodec };
        if (parsed.audioCodec) nvideo.audio = { codec: parsed.audioCodec };
        if (parsed.preset) (nvideo.video ||= {}).preset = parsed.preset;
        if (parsed.crf !== null) (nvideo.video ||= {}).crf = parsed.crf;
        if (parsed.width) (nvideo.video ||= {}).width = parsed.width;
        if (parsed.height) (nvideo.video ||= {}).height = parsed.height;
        if (parsed.fps) (nvideo.video ||= {}).fps = parsed.fps;
        if (parsed.filters) (nvideo.video ||= {}).filters = parsed.filters;
        if (parsed.videoOptions) (nvideo.video ||= {}).options = parsed.videoOptions;
        if (parsed.audioOptions) (nvideo.audio ||= {}).options = parsed.audioOptions;
        if (parsed.noAudio) nvideo.audio = null;
        if (parsed.noVideo) nvideo.video = null;
        if (parsed.hwaccel) nvideo.hwaccel = parsed.hwaccel;
        // Show auto-inferred hwaccel
        if (!parsed.hwaccel && parsed.videoCodec && parsed.videoCodec.includes('nvenc')) {
            nvideo.hwaccel = 'cuda (auto-inferred)';
        }
        cliPreview.textContent = JSON.stringify(nvideo, null, 2);
    }

    function populateVideoOptions(caps) {
        console.log('[populateVideoOptions] caps keys:', Object.keys(caps));
        const nVideoCaps = caps?.nVideo || caps;
        console.log('[populateVideoOptions] nVideoCaps keys:', Object.keys(nVideoCaps));
        const common = nVideoCaps?.commonCodecs || {};
        const allFormats = nVideoCaps?.formats?.all || [];
        console.log('[populateVideoOptions] common keys:', Object.keys(common));
        console.log('[populateVideoOptions] allFormats count:', allFormats.length);
        console.log('[populateVideoOptions] video encoders keys:', Object.keys(common.encoders?.video || {}));

        // Audio extract formats from muxable audio formats
        const audioExts = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus', 'wma', 'ac3', 'eac3', 'dts', 'pcm', 'aiff', 'au', 'wv']);
        const audioMuxable = allFormats.filter(f => f.canMux && f.extensions?.some(e => audioExts.has(e.toLowerCase())));
        const seenAudio = new Set();
        const audioFormats = [];
        audioMuxable.forEach(f => {
            f.extensions.forEach(e => {
                const ext = e.toLowerCase();
                if (audioExts.has(ext) && !seenAudio.has(ext)) {
                    seenAudio.add(ext);
                    audioFormats.push(ext);
                }
            });
        });
        if (audioFormats.length === 0) audioFormats.push('mp3', 'wav', 'ogg', 'm4a');
        console.log('[populateVideoOptions] audio formats:', audioFormats);
        audioFormatSelect.setItems(audioFormats.map(fmt => ({ value: fmt, label: fmt.toUpperCase() })));
        audioFormatSelect.setValue('mp3');

        // Video transcode containers from muxable video formats
        const videoExts = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'ts', 'flv', '3gp', 'ogv', 'wmv']);
        const videoMuxable = allFormats.filter(f => f.canMux && f.extensions?.some(e => videoExts.has(e.toLowerCase())));
        const seenVideo = new Set();
        const videoContainers = [];
        videoMuxable.forEach(f => {
            f.extensions.forEach(e => {
                const ext = e.toLowerCase();
                if (videoExts.has(ext) && !seenVideo.has(ext)) {
                    seenVideo.add(ext);
                    videoContainers.push(ext);
                }
            });
        });
        if (videoContainers.length === 0) videoContainers.push('mp4', 'webm', 'mkv', 'mov');
        console.log('[populateVideoOptions] video containers:', videoContainers);
        containerSelect.setItems(videoContainers.map(fmt => ({ value: fmt, label: fmt.toUpperCase() })));
        containerSelect.setValue('mp4');

        // Audio codecs (extract audio tab)
        const audioEncoders = common.encoders?.audio || [];
        console.log('[populateVideoOptions] audio encoders count:', audioEncoders.length);
        audioCodecSelect.setItems([
            { value: '', label: 'Auto' },
            ...audioEncoders.map(codec => ({ value: codec.name, label: codec.longName || codec.name }))
        ]);
        audioCodecSelect.setValue('');

        // Video codecs (flattened with platform)
        const videoEncoders = common.encoders?.video || {};
        const platformLabels = {
            cpu: 'CPU',
            nvidia: 'NVIDIA',
            intel: 'Intel Quick Sync',
            amd: 'AMD',
            other_hw: 'Other HW',
            professional: 'Professional'
        };
        const vcodecItems = [];
        Object.entries(videoEncoders).forEach(([group, encoders]) => {
            encoders.forEach(codec => {
                const platform = platformLabels[group] || group;
                vcodecItems.push({ value: codec.name, label: `[${platform}] ${codec.longName || codec.name}` });
            });
        });
        console.log('[populateVideoOptions] video codec items count:', vcodecItems.length);
        console.log('[populateVideoOptions] video codec items:', vcodecItems.map(i => i.value));
        vcodecSelect.setItems(vcodecItems);
        if (vcodecItems.length > 0) vcodecSelect.setValue(vcodecItems[0].value);

        // Audio codecs for transcode
        acodecSelect.setItems(audioEncoders.map(codec => ({ value: codec.name, label: codec.longName || codec.name })));
        if (audioEncoders.length > 0) {
            const aac = audioEncoders.find(c => c.name === 'aac');
            acodecSelect.setValue(aac ? aac.name : audioEncoders[0].name);
        }

        // Recommended
        if (common.recommended) {
            const rec = common.recommended;
            recommendedDiv.innerHTML = `<strong>Recommended:</strong> ${Object.entries(rec).map(([k, v]) => `${k}: ${v.video || ''}/${v.audio || ''}`).join(' | ')}`;
        }
    }
}
