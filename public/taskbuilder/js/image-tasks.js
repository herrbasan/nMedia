import {
    fetchCapabilities,
    loadPresets, savePreset, deletePreset, getPresetNames,
    runTask, downloadAsset, triggerDownload, getAssetMetadata,
    formatFileSize,
    showProgress, hideProgress, showResult, hideResult,
} from './task-builder.js';

export function initImageTasksPage(element, nui) {
    console.log('image tasks init');

    let selectedFile = null;
    let lastAssetId = null;
    let lastBlob = null;

    // Elements
    const fileInfo = element.querySelector('#image-file-info');
    const inputPath = element.querySelector('#image-input-path input');
    const maxDimSlider = element.querySelector('#image-max-dimension');
    const maxDimValue = element.querySelector('#image-max-dimension-value');
    const qualitySlider = element.querySelector('#image-quality');
    const qualityValue = element.querySelector('#image-quality-value');
    const formatSelect = element.querySelector('#image-format-select');
    const stripExif = element.querySelector('#image-strip-exif');
    const cropTypeSelect = element.querySelector('#image-crop-type select');
    const cropRegionDiv = element.querySelector('#image-crop-region');
    const cropCenterDiv = element.querySelector('#image-crop-center');
    const cropGridDiv = element.querySelector('#image-crop-grid');
    const cropCenterSizeSlider = element.querySelector('#crop-center-size');
    const cropCenterSizeValue = element.querySelector('#crop-center-size-value');
    const customOptions = element.querySelector('#image-custom-options textarea');
    const transportModeSelect = element.querySelector('#image-transport-mode select');
    const presetSelect = element.querySelector('#image-preset-select select');
    const loadPresetBtn = element.querySelector('#image-load-preset-btn');
    const savePresetBtn = element.querySelector('#image-save-preset-btn');
    const deletePresetBtn = element.querySelector('#image-delete-preset-btn');
    const runTaskBtn = element.querySelector('#image-run-task-btn');
    const runFormatMatrixBtn = element.querySelector('#image-run-format-matrix-btn');
    const runQualitySweepBtn = element.querySelector('#image-run-quality-sweep-btn');
    const progressSection = element.querySelector('#image-progress-section');
    const progressBar = element.querySelector('#image-progress-bar');
    const progressStatus = element.querySelector('#image-progress-status');
    const progressLog = element.querySelector('#image-progress-log');
    const resultSection = element.querySelector('#image-result-section');
    const resultContent = element.querySelector('#image-result-content');
    const downloadBtn = element.querySelector('#image-download-btn');
    const batchResultsSection = element.querySelector('#image-batch-results-section');
    const batchResults = element.querySelector('#image-batch-results');

    // Init
    fetchCapabilities().then(caps => {
        populateImageFormats(caps);
    });
    refreshPresets();

    // Slider updates
    maxDimSlider?.addEventListener('input', () => { maxDimValue.textContent = maxDimSlider.value; });
    qualitySlider?.addEventListener('input', () => { qualityValue.textContent = qualitySlider.value; });
    cropCenterSizeSlider?.addEventListener('input', () => { cropCenterSizeValue.textContent = cropCenterSizeSlider.value; });
    const blurSlider = element.querySelector('#image-blur');
    const blurValue = element.querySelector('#image-blur-value');
    blurSlider?.addEventListener('input', () => { blurValue.textContent = blurSlider.value; });

    // Crop type visibility
    cropTypeSelect?.addEventListener('change', () => {
        const type = cropTypeSelect.value;
        cropRegionDiv.style.display = type === 'region' ? '' : 'none';
        cropCenterDiv.style.display = type === 'center' ? '' : 'none';
        cropGridDiv.style.display = type === 'grid' ? '' : 'none';
    });

    // File picker
    const selectFileBtn = element.querySelector('#image-select-file-btn');
    selectFileBtn?.addEventListener('nui-file-selected', (e) => {
        if (e.detail.files.length > 0) handleFile(e.detail.files[0]);
    });

    function handleFile(file) {
        selectedFile = file;
        if (fileInfo) fileInfo.textContent = `${file.name} (${formatFileSize(file.size)})`;
    }

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
        if (preset.max_dimension) { maxDimSlider.value = preset.max_dimension; maxDimValue.textContent = preset.max_dimension; }
        if (preset.quality) { qualitySlider.value = preset.quality; qualityValue.textContent = preset.quality; }
        if (preset.format) formatSelect.value = preset.format;
        if (preset.strip_exif !== undefined) stripExif.checked = preset.strip_exif;
        if (preset.rotate && preset.rotate !== 'none') { const r = element.querySelector('#image-rotate select'); if (r) r.value = preset.rotate; }
        if (preset.flip) { const f = element.querySelector('#image-flip'); if (f) f.checked = true; }
        if (preset.flop) { const f = element.querySelector('#image-flop'); if (f) f.checked = true; }
        if (preset.grayscale) { const f = element.querySelector('#image-grayscale'); if (f) f.checked = true; }
        if (preset.normalize) { const f = element.querySelector('#image-normalize'); if (f) f.checked = true; }
        if (preset.blur) { const b = element.querySelector('#image-blur'); if (b) b.value = preset.blur; const bv = element.querySelector('#image-blur-value'); if (bv) bv.textContent = preset.blur; }
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
            const result = await runTask(
                selectedFile, inputPath?.value, 'image', options, transportMode,
                (data) => showProgress(progressSection, progressBar, progressStatus, progressLog, data.percent || 0, data.message || 'Processing...'),
                (data) => { lastAssetId = data.assetId; },
                (data) => { throw new Error(data.error || 'Processing failed'); }
            );

            hideProgress(progressSection);
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

            const metadata = await getAssetMetadata(lastAssetId);
            const hasCrop = options.crop && options.crop.type;
            const cropAssetIds = metadata?.metadata?.cropAssetIds || (hasCrop ? [lastAssetId] : null);

            let resultHtml;
            if (cropAssetIds && cropAssetIds.length > 0) {
                const blobs = await Promise.all(cropAssetIds.map(id => downloadAsset(id, `crop-${id}.${options.format || 'jpg'}`)));
                lastBlob = blobs[0];
                const totalSize = blobs.reduce((sum, b) => sum + b.size, 0);

                resultHtml = `
                    <div style="margin-bottom: 1rem;">
                        <strong>Asset ID:</strong> ${lastAssetId}<br>
                        <strong>Processing Time:</strong> ${elapsed}s<br>
                        <strong>Crop Type:</strong> ${options.crop.type} (${cropAssetIds.length} result${cropAssetIds.length > 1 ? 's' : ''})<br>
                        <strong>Total Size:</strong> ${formatFileSize(totalSize)}<br>
                        <strong>Options:</strong> ${JSON.stringify(options)}
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.5rem;">
                        ${blobs.map((blob, i) => {
                            const url = URL.createObjectURL(blob);
                            return `<div style="text-align: center;">
                                <img src="${url}" style="max-width: 100%; max-height: 300px; border-radius: 4px; border: 1px solid var(--nui-border);" />
                                <div style="font-size: 0.75rem; color: var(--nui-text-muted); margin-top: 0.25rem;">${hasCrop && options.crop.type === 'grid' ? `Cell ${i}` : `Crop ${i + 1}`} — ${formatFileSize(blob.size)}</div>
                            </div>`;
                        }).join('')}
                    </div>
                    ${metadata ? `<details style="margin-top: 1rem;"><summary>Metadata</summary><pre style="font-size: 0.8rem; overflow-x: auto;">${JSON.stringify(metadata, null, 2)}</pre></details>` : ''}
                `;
            } else {
                const blob = await downloadAsset(lastAssetId, `image-${options.format || 'output'}.${options.format || 'jpg'}`);
                lastBlob = blob;
                const url = URL.createObjectURL(blob);
                resultHtml = `
                    <div style="margin-bottom: 1rem;">
                        <strong>Asset ID:</strong> ${lastAssetId}<br>
                        <strong>Processing Time:</strong> ${elapsed}s<br>
                        <strong>Output Size:</strong> ${formatFileSize(blob.size)}<br>
                        <strong>Options:</strong> ${JSON.stringify(options)}
                    </div>
                    <img src="${url}" style="max-width: 100%; max-height: 400px; border-radius: 8px;" />
                    ${metadata ? `<details style="margin-top: 1rem;"><summary>Metadata</summary><pre style="font-size: 0.8rem; overflow-x: auto;">${JSON.stringify(metadata, null, 2)}</pre></details>` : ''}
                `;
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

    // Format matrix
    runFormatMatrixBtn?.addEventListener('nui-click', async () => {
        if (!selectedFile && !inputPath?.value) {
            nui.components.banner.show({ content: 'Select a file or enter a path first', priority: 'alert', placement: 'bottom', autoClose: 3000 });
            return;
        }

        runFormatMatrixBtn.setLoading(true);
        batchResultsSection.style.display = '';
        batchResults.innerHTML = '<p>Running format matrix...</p>';

        const formats = ['jpeg', 'png', 'webp', 'avif'];
        const results = [];

        for (const fmt of formats) {
            const options = { ...getOptions(), format: fmt };
            const startTime = performance.now();
            try {
                await runTask(
                    selectedFile, inputPath?.value, 'image', options, 'polling',
                    () => {},
                    (data) => { lastAssetId = data.assetId; },
                    (data) => { throw new Error(data.error); }
                );
                const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
                const metadata = await getAssetMetadata(lastAssetId);
                results.push({ format: fmt, elapsed, success: true, size: metadata?.size || 0 });
            } catch (e) {
                results.push({ format: fmt, elapsed: ((performance.now() - startTime) / 1000).toFixed(2), success: false, error: e.message });
            }
        }

        const originalSize = selectedFile ? selectedFile.size : 0;
        batchResults.innerHTML = `
            <table style="width: 100%; font-size: 0.85rem; border-collapse: collapse;">
                <thead>
                    <tr style="border-bottom: 1px solid var(--nui-border);">
                        <th style="text-align: left; padding: 0.5rem;">Format</th>
                        <th style="text-align: left; padding: 0.5rem;">Time</th>
                        <th style="text-align: left; padding: 0.5rem;">Size</th>
                        <th style="text-align: left; padding: 0.5rem;">Savings</th>
                        <th style="text-align: left; padding: 0.5rem;">Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${results.map(r => {
                        const savings = originalSize > 0 && r.success ? ((1 - r.size / originalSize) * 100).toFixed(1) : '-';
                        return `<tr style="border-bottom: 1px solid var(--nui-border);">
                            <td style="padding: 0.5rem;">${r.format.toUpperCase()}</td>
                            <td style="padding: 0.5rem;">${r.elapsed}s</td>
                            <td style="padding: 0.5rem;">${r.success ? formatFileSize(r.size) : '-'}</td>
                            <td style="padding: 0.5rem;">${savings}${savings !== '-' ? '%' : ''}</td>
                            <td style="padding: 0.5rem; color: ${r.success ? 'var(--nui-success)' : 'var(--nui-danger)'};">${r.success ? 'OK' : r.error}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        `;
        runFormatMatrixBtn.setLoading(false);
    });

    // Quality sweep
    runQualitySweepBtn?.addEventListener('nui-click', async () => {
        if (!selectedFile && !inputPath?.value) {
            nui.components.banner.show({ content: 'Select a file or enter a path first', priority: 'alert', placement: 'bottom', autoClose: 3000 });
            return;
        }

        runQualitySweepBtn.setLoading(true);
        batchResultsSection.style.display = '';
        batchResults.innerHTML = '<p>Running quality sweep...</p>';

        const qualities = [10, 25, 50, 75, 85, 95, 100];
        const results = [];

        for (const q of qualities) {
            const options = { ...getOptions(), quality: q };
            const startTime = performance.now();
            try {
                await runTask(
                    selectedFile, inputPath?.value, 'image', options, 'polling',
                    () => {},
                    (data) => { lastAssetId = data.assetId; },
                    (data) => { throw new Error(data.error); }
                );
                const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
                const metadata = await getAssetMetadata(lastAssetId);
                results.push({ quality: q, elapsed, success: true, size: metadata?.size || 0 });
            } catch (e) {
                results.push({ quality: q, elapsed: ((performance.now() - startTime) / 1000).toFixed(2), success: false, error: e.message });
            }
        }

        const originalSize = selectedFile ? selectedFile.size : 0;
        batchResults.innerHTML = `
            <table style="width: 100%; font-size: 0.85rem; border-collapse: collapse;">
                <thead>
                    <tr style="border-bottom: 1px solid var(--nui-border);">
                        <th style="text-align: left; padding: 0.5rem;">Quality</th>
                        <th style="text-align: left; padding: 0.5rem;">Time</th>
                        <th style="text-align: left; padding: 0.5rem;">Size</th>
                        <th style="text-align: left; padding: 0.5rem;">Savings</th>
                        <th style="text-align: left; padding: 0.5rem;">Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${results.map(r => {
                        const savings = originalSize > 0 && r.success ? ((1 - r.size / originalSize) * 100).toFixed(1) : '-';
                        return `<tr style="border-bottom: 1px solid var(--nui-border);">
                            <td style="padding: 0.5rem;">${r.quality}</td>
                            <td style="padding: 0.5rem;">${r.elapsed}s</td>
                            <td style="padding: 0.5rem;">${r.success ? formatFileSize(r.size) : '-'}</td>
                            <td style="padding: 0.5rem;">${savings}${savings !== '-' ? '%' : ''}</td>
                            <td style="padding: 0.5rem; color: ${r.success ? 'var(--nui-success)' : 'var(--nui-danger)'};">${r.success ? 'OK' : r.error}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        `;
        runQualitySweepBtn.setLoading(false);
    });

    // Download
    downloadBtn?.addEventListener('nui-click', () => {
        if (lastBlob) {
            triggerDownload(lastBlob, `image-output.${formatSelect.value || 'jpg'}`);
        }
    });

    function getOptions() {
        const options = {
            max_dimension: parseInt(maxDimSlider.value),
            quality: parseInt(qualitySlider.value),
            format: formatSelect.value,
            strip_exif: stripExif.checked,
        };

        const rotateSelect = element.querySelector('#image-rotate select');
        if (rotateSelect?.value && rotateSelect.value !== 'none') options.rotate = parseInt(rotateSelect.value);
        const flipCb = element.querySelector('#image-flip');
        if (flipCb?.checked) options.flip = true;
        const flopCb = element.querySelector('#image-flop');
        if (flopCb?.checked) options.flop = true;
        const grayscaleCb = element.querySelector('#image-grayscale');
        if (grayscaleCb?.checked) options.grayscale = true;
        const normalizeCb = element.querySelector('#image-normalize');
        if (normalizeCb?.checked) options.normalize = true;
        const blurSlider = element.querySelector('#image-blur');
        const blurVal = parseFloat(blurSlider?.value || 0);
        if (blurVal > 0) options.blur = blurVal;

        const cropType = cropTypeSelect.value;
        if (cropType === 'region') {
            options.crop = {
                type: 'region',
                left: parseFloat(element.querySelector('#crop-x')?.value || 0.25),
                top: parseFloat(element.querySelector('#crop-y')?.value || 0.25),
                right: parseFloat(element.querySelector('#crop-w')?.value || 0.75),
                bottom: parseFloat(element.querySelector('#crop-h')?.value || 0.75),
            };
        } else if (cropType === 'center') {
            const size = parseInt(cropCenterSizeSlider.value);
            options.crop = { type: 'center', width: size, height: size };
        } else if (cropType === 'grid') {
            const cols = parseInt(element.querySelector('#crop-grid-cols')?.value || 3);
            const rows = parseInt(element.querySelector('#crop-grid-rows')?.value || 3);
            const cells = [];
            for (let i = 0; i < cols * rows; i++) cells.push(i);
            options.crop = { type: 'grid', cols, rows, cells };
        }

        if (customOptions.value.trim()) {
            try { Object.assign(options, JSON.parse(customOptions.value)); } catch (e) {
                nui.components.banner.show({ content: 'Invalid custom JSON: ' + e.message, priority: 'alert', placement: 'bottom', autoClose: 3000 });
            }
        }
        return options;
    }

    function populateImageFormats(caps) {
        const nImageCaps = caps?.nImage || caps;
        const encoders = nImageCaps?.encoders?.formats || ['jpeg', 'png', 'webp', 'avif', 'tiff'];
        formatSelect.innerHTML = '';
        encoders.forEach(fmt => {
            const opt = document.createElement('option');
            opt.value = fmt;
            opt.textContent = fmt.toUpperCase();
            formatSelect.appendChild(opt);
        });
        const nuiSelect = formatSelect.closest('nui-select');
        if (nuiSelect) nuiSelect.syncOptions();
    }
}
