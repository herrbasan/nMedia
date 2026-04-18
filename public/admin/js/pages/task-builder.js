import { uploadFile, processJob, fetchAsset, fetchAssetMetadata } from '../api-client.js';
import { adminWs } from '../ws-client.js';

export function initTaskBuilderPage(element, nui) {
    const inputTypeTabs = element.querySelectorAll('[name="input-type"]');
    const fileInput = element.querySelector('#builder-file input[type="file"]');
    const pathInput = element.querySelector('#builder-path');
    const processorSelect = element.querySelector('#builder-processor select');
    const optionsPanel = element.querySelector('#builder-options');
    const outputTypeRadios = element.querySelectorAll('[name="output-type"]');
    const outputPathPanel = element.querySelector('#output-path-panel');
    const outputPathInput = element.querySelector('#builder-output-path input');
    const runBtn = element.querySelector('#run-builder-btn');
    const resultPanel = element.querySelector('#builder-result');

    let currentJobId = null;

    const OPTIONS_SCHEMA = {
        image: [
            { name: 'max_dimension', label: 'Max Dimension', type: 'number', default: 1024 },
            { name: 'quality', label: 'Quality', type: 'number', default: 85 },
            { name: 'format', label: 'Format', type: 'select', default: 'jpeg', choices: ['jpeg', 'png', 'webp', 'avif', 'gif'] },
            { name: 'crop_type', label: 'Crop Type', type: 'select', default: '', choices: ['', 'region', 'center', 'grid'] },
        ],
        audio: [
            { name: 'sample_rate', label: 'Sample Rate', type: 'select', default: '16000', choices: ['8000', '16000', '22050', '44100', '48000', 'source'] },
            { name: 'channels', label: 'Channels', type: 'select', default: '1', choices: ['1', '2', 'source'] },
            { name: 'format', label: 'Format', type: 'select', default: 'mp3', choices: ['mp3', 'wav', 'ogg', 'm4a'] },
        ],
        video: [
            { name: 'mode', label: 'Mode', type: 'select', default: 'transcode', choices: ['extract_audio', 'extract_keyframes', 'transcode'] },
            { name: 'fps', label: 'FPS', type: 'number', default: 1, modes: ['extract_keyframes'] },
            { name: 'max_dimension', label: 'Max Dimension', type: 'number', default: 1024, modes: ['extract_keyframes', 'transcode'] },
            { name: 'output_format', label: 'Container', type: 'select', default: 'mp4', choices: ['mp4', 'webm', 'mkv', 'mov'], modes: ['transcode'] },
            { name: 'video_codec', label: 'Video Codec', type: 'select', default: 'libx264', choices: ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'h264_vaapi', 'hevc_vaapi', 'h264_qsv', 'hevc_qsv'], modes: ['transcode'] },
            { name: 'audio_codec', label: 'Audio Codec', type: 'select', default: 'aac', choices: ['aac', 'libmp3lame', 'pcm_s16le', 'libvorbis'], modes: ['transcode'] },
            { name: 'width', label: 'Width', type: 'number', default: '', modes: ['transcode'] },
            { name: 'height', label: 'Height', type: 'number', default: '', modes: ['transcode'] },
            { name: 'crf', label: 'CRF', type: 'number', default: 23, modes: ['transcode'] },
            { name: 'preset', label: 'Preset', type: 'select', default: 'medium', choices: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'], modes: ['transcode'] },
            { name: 'audio_bitrate', label: 'Audio Bitrate', type: 'number', default: 128000, modes: ['transcode'] },
        ],
    };

    function getFieldModes(opt) {
        // If no modes specified, field applies to all modes
        return opt.modes || null;
    }

    function updateFieldVisibility() {
        const proc = processorSelect.value;
        if (proc !== 'video') return;
        const modeEl = element.querySelector('#opt-mode select');
        const mode = modeEl ? modeEl.value : 'transcode';
        const schema = OPTIONS_SCHEMA.video;
        for (const opt of schema) {
            if (opt.name === 'mode') continue;
            const wrapper = element.querySelector(`#opt-${opt.name}`)?.closest('div');
            if (!wrapper) continue;
            const modes = getFieldModes(opt);
            const visible = !modes || modes.includes(mode);
            wrapper.style.display = visible ? '' : 'none';
        }
    }

    function renderOptions() {
        const proc = processorSelect.value;
        const schema = OPTIONS_SCHEMA[proc] || [];
        optionsPanel.innerHTML = schema.map(opt => {
            const modes = getFieldModes(opt);
            const modeAttr = modes ? ` data-modes="${modes.join(',')}"` : '';
            if (opt.type === 'select') {
                return `
                    <div${modeAttr}>
                        <label>${opt.label}</label>
                        <nui-select id="opt-${opt.name}">
                            <select>${opt.choices.map(c => `<option value="${c}" ${c === String(opt.default) ? 'selected' : ''}>${c}</option>`).join('')}</select>
                        </nui-select>
                    </div>
                `;
            }
            return `
                <div${modeAttr}>
                    <label>${opt.label}</label>
                    <nui-text-field id="opt-${opt.name}">
                        <input type="${opt.type}" value="${opt.default}">
                    </nui-text-field>
                </div>
            `;
        }).join('');

        // After DOM update, attach mode-change listener for video
        if (proc === 'video') {
            const modeSelect = element.querySelector('#opt-mode select');
            if (modeSelect) {
                modeSelect.addEventListener('change', updateFieldVisibility);
            }
            updateFieldVisibility();
        }
    }

    processorSelect?.addEventListener('change', renderOptions);
    renderOptions();

    // Toggle output path panel
    outputTypeRadios.forEach(r => {
        r.addEventListener('change', () => {
            if (outputPathPanel) {
                outputPathPanel.style.display = r.value === 'path' ? '' : 'none';
            }
        });
    });

    function getSelectedInputType() {
        for (const r of inputTypeTabs) if (r.checked) return r.value;
        return 'file';
    }

    function getOutputType() {
        for (const r of outputTypeRadios) if (r.checked) return r.value;
        return 'display';
    }

    function collectOptions() {
        const proc = processorSelect.value;
        const schema = OPTIONS_SCHEMA[proc] || [];
        const opts = {};
        for (const opt of schema) {
            const el = element.querySelector(`#opt-${opt.name} input`) || element.querySelector(`#opt-${opt.name} select`);
            if (!el) continue;

            // Skip fields hidden for current mode
            const modes = getFieldModes(opt);
            if (modes) {
                const modeEl = element.querySelector('#opt-mode select');
                const currentMode = modeEl ? modeEl.value : 'transcode';
                if (!modes.includes(currentMode)) continue;
            }

            let val = el.value;
            if (val === '' || val === undefined || val === null) continue;
            if (opt.type === 'number') {
                const num = parseInt(val);
                if (isNaN(num)) continue;
                val = num;
            }
            opts[opt.name] = val;
        }

        // Map crop_type to crop object for image processor
        if (proc === 'image' && opts.crop_type) {
            const type = opts.crop_type;
            delete opts.crop_type;
            if (type === 'region') {
                opts.crop = { type: 'region', left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 };
            } else if (type === 'center') {
                opts.crop = { type: 'center', width: 50, height: 50 };
            } else if (type === 'grid') {
                opts.crop = { type: 'grid', grid: { cols: 2, rows: 2, cells: [0, 1, 2, 3] } };
            }
        }

        return opts;
    }

    runBtn?.addEventListener('nui-click', async () => {
        console.log('Task Builder: run clicked');
        resultPanel.innerHTML = '<p>Starting...</p>';
        if (runBtn.setLoading) runBtn.setLoading(true);
        try {
            const proc = processorSelect.value;
            const opts = collectOptions();
            const outType = getOutputType();
            const mode = opts.mode;
            if (mode !== undefined) delete opts.mode;
            let body = { processor: proc, mode, options: opts };
            console.log('Task Builder: collected opts', opts, 'mode', mode, 'body', body);

            const inputType = getSelectedInputType();
            if (inputType === 'file') {
                if (!fileInput.files?.length) throw new Error('Select a file');
                const uploadData = await uploadFile(fileInput.files[0]);
                body.fileId = uploadData.fileId;
            } else {
                if (!pathInput.value.trim()) throw new Error('Enter an input path');
                body.input_path = pathInput.value.trim();
            }

            if (outType === 'path') {
                if (!outputPathInput.value.trim()) throw new Error('Enter an output path');
                body.output_path = outputPathInput.value.trim();
            }

            const jobData = await processJob(body);
            currentJobId = jobData.jobId;
            resultPanel.innerHTML = `<p>Job created: <code>${jobData.jobId}</code></p><div id="builder-progress"></div>`;

            adminWs.subscribe(jobData.jobId);
            const progressEl = resultPanel.querySelector('#builder-progress');

            const unsubProgress = adminWs.on('progress', (data) => {
                if (data.jobId !== jobData.jobId) return;
                const msg = typeof data.message === 'string' ? data.message : (data.message ? JSON.stringify(data.message) : 'Processing...');
                progressEl.innerHTML = `<div class="job-progress"><div class="job-progress-bar" style="width:${data.percent || 0}%"></div></div><div class="job-message">${msg}</div>`;
            });

            const unsubComplete = adminWs.on('complete', async (data) => {
                if (data.jobId !== jobData.jobId) return;
                const assetId = data.assetId || data.result?.assetId;
                if (!assetId && outType === 'display') return; // wait for the event with assetId
                unsubProgress();
                unsubComplete();
                adminWs.unsubscribe(jobData.jobId);
                if (assetId && outType === 'display') {
                    await showResult(assetId, proc);
                } else if (outType === 'path') {
                    progressEl.innerHTML = `<nui-banner priority="success">Saved to ${body.output_path}</nui-banner>`;
                } else {
                    progressEl.innerHTML = `<nui-banner priority="success">Done</nui-banner>`;
                }
                if (runBtn.setLoading) runBtn.setLoading(false);
            });

            const unsubError = adminWs.on('error', (data) => {
                if (data.jobId !== jobData.jobId) return;
                unsubProgress();
                unsubComplete();
                unsubError();
                adminWs.unsubscribe(jobData.jobId);
                progressEl.innerHTML = `<nui-banner priority="alert">Error: ${data.error}</nui-banner>`;
                if (runBtn.setLoading) runBtn.setLoading(false);
            });
        } catch (e) {
            console.error('Task Builder error:', e);
            resultPanel.innerHTML = `<nui-banner priority="alert">${e.message}</nui-banner>`;
            if (runBtn.setLoading) runBtn.setLoading(false);
        }
    });

    async function showResult(assetId, processor) {
        try {
            const url = `/v1/assets/${assetId}`;
            let html = '';
            if (processor === 'image') {
                html = `<img src="${url}" style="max-width:100%;max-height:300px;border-radius:4px;">`;
            } else if (processor === 'audio') {
                html = `<audio controls src="${url}"></audio>`;
            } else if (processor === 'video') {
                html = `<video controls src="${url}" style="max-height:300px;"></video>`;
            } else {
                html = `<a href="${url}" download>Download result</a>`;
            }
            resultPanel.innerHTML = `<div style="margin-top:1rem;">${html}</div><div style="margin-top:0.5rem;"><a href="${url}" download class="nui-button"><button type="button">Download</button></a></div>`;
        } catch (e) {
            resultPanel.innerHTML += `<p style="color:var(--nui-danger)">Preview failed: ${e.message}</p>`;
        }
    }
}
