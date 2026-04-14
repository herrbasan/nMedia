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
    const fpsSlider = element.querySelector('#fps');
    const fpsValue = element.querySelector('#fps-value');
    const processBtn = element.querySelector('#process-video-btn');
    const processingDialog = element.querySelector('#video-processing-dialog');
    const downloadBtn = element.querySelector('#video-download-btn');

    modeSelect?.addEventListener('nui-change', (e) => {
        const mode = e.detail.values[0];
        if (keyframeOptions) {
            keyframeOptions.style.display = mode === 'extract_keyframes' ? 'block' : 'none';
        }
    });

    fpsSlider?.addEventListener('input', (e) => {
        if (fpsValue) fpsValue.textContent = e.target.value;
    });

    selectBtn?.addEventListener('nui-file-selected', (e) => {
        if (e.detail.files.length > 0) {
            handleFile(e.detail.files[0]).catch(err => {
                console.error('handleFile error:', err);
            });
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
        }

        try {
            const formData = new FormData();
            formData.append('file', currentFile);
            formData.append('mode', mode);
            if (mode === 'extract_keyframes') {
                formData.append('fps', options.fps);
                formData.append('max_dimension', options.max_dimension);
            }
            formData.append('response_type', 'base64');

            const response = await fetch(`${API_BASE}/v1/process/video`, {
                method: 'POST',
                body: formData
            });

            processingDialog?.close();

            if (response.ok) {
                const data = await response.json();
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
            const optimizedSize = data.processed_size_bytes || 0;
            const elapsed = startTime ? ((performance.now() - startTime) / 1000).toFixed(2) : 'N/A';
            
            const rows = [
                { label: 'Original Size', value: formatFileSize(originalSize) },
                { label: 'Processed Size', value: formatFileSize(optimizedSize) },
                { label: 'Mode', value: mode === 'extract_audio' ? 'Audio Extraction' : 'Keyframe Extraction' },
            ];
            
            if (data.duration) {
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
        link.href = processedData.base64;
        link.download = `extracted_audio_${currentFile.name.replace(/\.[^/.]+$/, '')}.mp3`;
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
