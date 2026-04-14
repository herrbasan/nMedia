const API_BASE = 'http://localhost:3500';

export function initVideoPage(element, nui) {
    console.log('video init');
    let currentFile = null;
    let processedData = null;
    let originalVideoUrl = null;

    const selectBtn = element.querySelector('#select-video-btn');
    const optionsSection = element.querySelector('#video-options');
    const modeSelect = element.querySelector('#video-mode-select');
    const keyframeOptions = element.querySelector('#keyframe-options');
    const transcodeOptions = element.querySelector('#transcode-options');
    const fpsSlider = element.querySelector('#fps');
    const fpsValue = element.querySelector('#fps-value');
    const crfSlider = element.querySelector('#crf');
    const crfValueEl = element.querySelector('#crf-value');
    const processBtn = element.querySelector('#process-video-btn');
    const processingDialog = element.querySelector('#video-processing-dialog');
    const downloadBtn = element.querySelector('#video-download-btn');

    modeSelect?.addEventListener('nui-change', (e) => {
        const mode = e.detail.values[0];
        if (keyframeOptions) {
            keyframeOptions.style.display = mode === 'extract_keyframes' ? 'block' : 'none';
        }
        if (transcodeOptions) {
            transcodeOptions.style.display = mode === 'transcode' ? 'block' : 'none';
        }
    });

    fpsSlider?.addEventListener('input', (e) => {
        if (fpsValue) fpsValue.textContent = e.target.value;
    });

    crfSlider?.addEventListener('input', (e) => {
        if (crfValueEl) crfValueEl.textContent = e.target.value;
    });

    selectBtn?.addEventListener('nui-file-selected', (e) => {
        if (e.detail.files.length > 0) {
            handleFile(e.detail.files[0]);
        }
    });

    function handleFile(file) {
        currentFile = file;
        if (optionsSection) optionsSection.style.display = 'block';
        
        if (originalVideoUrl) URL.revokeObjectURL(originalVideoUrl);
        originalVideoUrl = URL.createObjectURL(file);
        
        const fileInfo = element.querySelector('#file-info');
        if (fileInfo) {
            while (fileInfo.firstChild) {
                fileInfo.removeChild(fileInfo.firstChild);
            }
            
            const nameRow = document.createElement('div');
            nameRow.innerHTML = `<strong>Name:</strong> ${file.name}`;
            const sizeRow = document.createElement('div');
            sizeRow.innerHTML = `<strong>Size:</strong> ${formatFileSize(file.size)}`;
            const typeRow = document.createElement('div');
            typeRow.innerHTML = `<strong>Type:</strong> ${file.type || 'Unknown'}`;
            
            fileInfo.appendChild(nameRow);
            fileInfo.appendChild(sizeRow);
            fileInfo.appendChild(typeRow);
        }

        optionsSection?.scrollIntoView({ behavior: 'smooth' });
    }

    processBtn?.addEventListener('click', async () => {
        if (!currentFile) return;

        processingDialog?.showModal();
        const startTime = performance.now();

        const modeSelectEl = element.querySelector('#video-mode-select select');
        const mode = modeSelectEl?.value || 'extract_audio';
        const options = { mode };

        if (mode === 'extract_keyframes') {
            options.fps = parseInt(fpsSlider?.value || 1);
            options.max_dimension = parseInt(element.querySelector('#video-max-dimension')?.value || 1024);
        } else if (mode === 'transcode') {
            const outputFormatEl = element.querySelector('#output-format-select select');
            const videoCodecEl = element.querySelector('#video-codec-select select');
            const audioCodecEl = element.querySelector('#audio-codec-select select');
            const presetEl = element.querySelector('#preset-select select');
            const widthEl = element.querySelector('#transcode-width');
            const heightEl = element.querySelector('#transcode-height');

            options.output_format = outputFormatEl?.value || 'mp4';
            options.video_codec = videoCodecEl?.value || 'libx264';
            options.audio_codec = audioCodecEl?.value || 'aac';
            options.crf = parseInt(crfSlider?.value || 23);
            options.preset = presetEl?.value || 'medium';
            if (widthEl?.value) options.width = parseInt(widthEl.value);
            if (heightEl?.value) options.height = parseInt(heightEl.value);
        }

        try {
            const formData = new FormData();
            formData.append('file', currentFile);
            formData.append('mode', mode);
            formData.append('response_type', mode === 'transcode' ? 'file' : 'base64');

            if (mode === 'extract_keyframes') {
                formData.append('fps', options.fps);
                formData.append('max_dimension', options.max_dimension);
            } else if (mode === 'transcode') {
                formData.append('output_format', options.output_format);
                formData.append('video_codec', options.video_codec);
                formData.append('audio_codec', options.audio_codec);
                formData.append('crf', options.crf);
                formData.append('preset', options.preset);
                if (options.width) formData.append('width', options.width);
                if (options.height) formData.append('height', options.height);
            }

            const response = await fetch(`${API_BASE}/v1/process/video`, {
                method: 'POST',
                body: formData
            });

            processingDialog?.close();

            if (response.ok) {
                let data;
                if (mode === 'transcode') {
                    // File response - create blob URL
                    const blob = await response.blob();
                    const blobUrl = URL.createObjectURL(blob);
                    data = {
                        base64: blobUrl,
                        original_size_bytes: currentFile.size,
                        output_size_bytes: blob.size,
                        mode: 'transcode',
                        output_format: options.output_format,
                    };
                } else {
                    data = await response.json();
                }
                
                if (mode === 'extract_audio' && !data.base64) {
                    nui.components.banner.show({
                        content: 'Error: API response missing base64 field',
                        priority: 'alert',
                        placement: 'bottom',
                        autoClose: 5000
                    });
                    return;
                }
                processedData = data;
                displayResult(data, mode, startTime);
                
                const tabs = element.querySelector('nui-tabs');
                if (tabs) tabs.selectTab(1);
                
                nui.components.banner.show({
                    content: 'Video processed successfully!',
                    priority: 'info',
                    placement: 'bottom',
                    autoClose: 4000
                });
            } else {
                const errorText = await response.text();
                nui.components.banner.show({
                    content: `Processing failed: HTTP ${response.status} - ${errorText}`,
                    priority: 'alert',
                    placement: 'bottom',
                    autoClose: 5000
                });
            }
        } catch (error) {
            processingDialog?.close();
            nui.components.banner.show({
                content: `Processing failed: ${error.message}`,
                priority: 'alert',
                placement: 'bottom',
                autoClose: 5000
            });
        }
    });

    function displayResult(data, mode, startTime) {
        const placeholder = element.querySelector('#video-result-placeholder');
        const resultCard = element.querySelector('#video-result-card');
        
        if (placeholder) placeholder.style.display = 'none';
        if (resultCard) resultCard.style.display = 'block';

        const resultDiv = element.querySelector('#video-processed-result');
        const downloadBtnEl = element.querySelector('#video-download-btn');
        
        if (!resultDiv) return;
        
        while (resultDiv.firstChild) {
            resultDiv.removeChild(resultDiv.firstChild);
        }

        if (mode === 'extract_audio') {
            const info = document.createElement('div');
            info.style.marginBottom = '1rem';
            info.innerHTML = '<p>Audio track extracted successfully</p>';
            resultDiv.appendChild(info);
            
            if (data.base64) {
                const audio = document.createElement('audio');
                audio.setAttribute('controls', '');
                audio.setAttribute('src', data.base64);
                audio.style.cssText = 'width: 100%;';
                resultDiv.appendChild(audio);
            } else {
                const error = document.createElement('p');
                error.style.cssText = 'color: red;';
                error.textContent = 'Error: No audio data received';
                resultDiv.appendChild(error);
            }
            if (downloadBtnEl) downloadBtnEl.style.display = 'block';
        } else if (mode === 'transcode') {
            const info = document.createElement('div');
            info.style.marginBottom = '1rem';
            info.innerHTML = '<p>Video transcoded successfully</p>';
            resultDiv.appendChild(info);
            
            if (data.base64) {
                const video = document.createElement('video');
                video.setAttribute('controls', '');
                video.setAttribute('src', data.base64);
                video.style.cssText = 'width: 100%; max-height: 400px;';
                resultDiv.appendChild(video);
            } else {
                const error = document.createElement('p');
                error.style.cssText = 'color: red;';
                error.textContent = 'Error: No video data received';
                resultDiv.appendChild(error);
            }
            if (downloadBtnEl) downloadBtnEl.style.display = 'block';
        } else {
            if (data.frames && Array.isArray(data.frames)) {
                const grid = document.createElement('div');
                grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 1rem;';
                
                data.frames.forEach((frame, i) => {
                    const card = document.createElement('nui-card');
                    card.style.padding = '0.5rem';
                    
                    const img = document.createElement('img');
                    img.src = `data:image/jpeg;base64,${frame}`;
                    img.style.cssText = 'width: 100%; border-radius: 4px;';
                    card.appendChild(img);
                    
                    const p = document.createElement('p');
                    p.style.cssText = 'text-align: center; margin: 0.5rem 0 0; font-size: 0.8rem;';
                    p.textContent = `Frame ${i + 1}`;
                    card.appendChild(p);
                    
                    grid.appendChild(card);
                });
                
                resultDiv.appendChild(grid);
            } else {
                const p = document.createElement('p');
                p.textContent = 'Keyframes extracted';
                resultDiv.appendChild(p);
            }
            if (downloadBtnEl) downloadBtnEl.style.display = 'none';
        }

        const info = element.querySelector('#video-result-info');
        if (info) {
            while (info.firstChild) {
                info.removeChild(info.firstChild);
            }
            
            const originalSize = data.original_size_bytes || 0;
            const optimizedSize = data.processed_size_bytes || data.output_size_bytes || 0;
            const elapsed = startTime ? ((performance.now() - startTime) / 1000).toFixed(2) : 'N/A';
            
            const rows = [
                { label: 'Original Size', value: formatFileSize(originalSize) },
                { label: 'Processed Size', value: formatFileSize(optimizedSize) },
            ];

            if (mode === 'extract_audio') {
                rows.push({ label: 'Mode', value: 'Audio Extraction' });
            } else if (mode === 'transcode') {
                rows.push({ label: 'Mode', value: 'Transcode' });
                if (data.video_codec) rows.push({ label: 'Video Codec', value: data.video_codec });
                if (data.audio_codec) rows.push({ label: 'Audio Codec', value: data.audio_codec });
                if (data.output_format) rows.push({ label: 'Container', value: data.output_format.toUpperCase() });
                if (data.dimensions) rows.push({ label: 'Dimensions', value: data.dimensions });
                if (data.duration) rows.push({ label: 'Duration', value: `${data.duration.toFixed(1)}s` });
            } else {
                rows.push({ label: 'Mode', value: 'Keyframe Extraction' });
            }
            
            if (data.duration && mode !== 'transcode') {
                rows.splice(2, 0, { label: 'Duration', value: `${(data.duration / 1000).toFixed(1)}s` });
            }
            
            rows.push({ label: 'Processing Time', value: `${elapsed}s` });
            
            rows.forEach(row => {
                const div = document.createElement('div');
                div.innerHTML = `<strong>${row.label}:</strong> ${row.value}`;
                info.appendChild(div);
            });
        }
    }

    downloadBtn?.addEventListener('click', () => {
        if (!processedData || !currentFile) return;
        
        const link = document.createElement('a');
        const baseName = currentFile.name.replace(/\.[^/.]+$/, '');
        
        if (processedData.mode === 'transcode') {
            link.href = processedData.base64;
            const ext = processedData.output_format || 'mp4';
            link.download = `transcoded_${baseName}.${ext}`;
        } else if (processedData.base64 && processedData.base64.startsWith('data:')) {
            link.href = processedData.base64;
            link.download = `extracted_audio_${baseName}.mp3`;
        } else {
            return;
        }
        link.click();
    });

    function formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}
