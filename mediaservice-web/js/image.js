const API_BASE = 'http://localhost:3500';

export function initImagePage(element, nui) {
    console.log('image init');
    let currentFile = null;
    let processedData = null;

    const dropzone = element.querySelector('#image-dropzone');
    const selectBtn = element.querySelector('#select-image-btn');
    const optionsSection = element.querySelector('#image-options');
    const qualitySlider = element.querySelector('#quality');
    const qualityValue = element.querySelector('#quality-value');
    const processBtn = element.querySelector('#process-image-btn');
    const processingDialog = element.querySelector('#processing-dialog');
    const downloadBtn = element.querySelector('#download-btn');

    qualitySlider?.addEventListener('input', (e) => {
        if (qualityValue) qualityValue.textContent = e.target.value;
    });

    selectBtn?.addEventListener('nui-file-selected', (e) => {
        if (e.detail.files.length > 0) {
            handleFile(e.detail.files[0]).catch(err => {
                console.error('handleFile error:', err);
            });
        }
    });

    dropzone?.addEventListener('nui-dropzone-drop', (e) => {
        e.preventDefault();
        const files = e.detail.dataTransfer.files;
        if (files.length > 0) {
            handleFile(files[0]).catch(err => {
                console.error('handleFile error:', err);
            });
        }
    });

    function handleFile(file) {
        currentFile = file;
        if (optionsSection) optionsSection.style.display = 'block';
        
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

        const formatSelect = element.querySelector('#format-select select');
        const options = {
            max_dimension: parseInt(element.querySelector('#max-dimension')?.value || 1024),
            quality: parseInt(qualitySlider?.value || 85),
            format: formatSelect?.value || 'jpeg',
            strip_exif: element.querySelector('#strip-exif')?.checked ?? true
        };

        try {
            const formData = new FormData();
            formData.append('file', currentFile);
            formData.append('max_dimension', options.max_dimension);
            formData.append('quality', options.quality);
            formData.append('format', options.format);
            formData.append('strip_exif', options.strip_exif);
            formData.append('response_type', 'base64');

            const response = await fetch(`${API_BASE}/v1/process/image`, {
                method: 'POST',
                body: formData
            });

            processingDialog?.close();

            if (response.ok) {
                const data = await response.json();
                if (!data.base64) {
                    nui.components.banner.show({
                        content: 'Error: API response missing base64 field',
                        priority: 'alert',
                        placement: 'bottom',
                        autoClose: 5000
                    });
                    return;
                }
                processedData = data;
                displayResult(data, startTime);
                
                const tabs = element.querySelector('nui-tabs');
                if (tabs) tabs.selectTab(1);
                
                nui.components.banner.show({
                    content: `Image processed successfully! Saved ${formatFileSize(data.original_size_bytes - data.processed_size_bytes)}`,
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

    function displayResult(data, startTime) {
        const placeholder = element.querySelector('#result-placeholder');
        const resultCard = element.querySelector('#result-card');
        
        if (placeholder) placeholder.style.display = 'none';
        if (resultCard) resultCard.style.display = 'block';

        const formatSelect = element.querySelector('#format-select select');
        const format = formatSelect?.value || 'jpeg';
        
        const resultDiv = element.querySelector('#processed-result');
        if (resultDiv) {
            while (resultDiv.firstChild) {
                resultDiv.removeChild(resultDiv.firstChild);
            }
            
            if (data.base64) {
                const img = document.createElement('img');
                img.src = data.base64;
                img.style.cssText = 'max-width: 100%; max-height: 400px; border-radius: 8px;';
                resultDiv.appendChild(img);
            } else {
                const error = document.createElement('p');
                error.style.cssText = 'color: red;';
                error.textContent = 'Error: No image data received';
                resultDiv.appendChild(error);
            }
        }

        const info = element.querySelector('#result-info');
        if (info) {
            while (info.firstChild) {
                info.removeChild(info.firstChild);
            }
            
            const originalSize = data.original_size_bytes || 0;
            const optimizedSize = data.processed_size_bytes || 0;
            const savings = originalSize > 0 ? ((originalSize - optimizedSize) / originalSize * 100).toFixed(1) : '0.0';
            const elapsed = startTime ? ((performance.now() - startTime) / 1000).toFixed(2) : 'N/A';
            
            const rows = [
                { label: 'Original', value: formatFileSize(originalSize) },
                { label: 'Processed', value: formatFileSize(optimizedSize) },
                { label: 'Savings', value: `${savings}%` },
                { label: 'Dimensions', value: `${data.width || 'N/A'} × ${data.height || 'N/A'}` },
                { label: 'Processing Time', value: `${elapsed}s` }
            ];
            
            rows.forEach(row => {
                const div = document.createElement('div');
                div.innerHTML = `<strong>${row.label}:</strong> ${row.value}`;
                info.appendChild(div);
            });
        }
    }

    downloadBtn?.addEventListener('click', () => {
        if (!processedData || !currentFile) return;
        
        const formatSelect = element.querySelector('#format-select select');
        const format = formatSelect?.value || 'jpeg';
        
        const link = document.createElement('a');
        link.href = processedData.base64;
        link.download = `processed_${currentFile.name.replace(/\.[^/.]+$/, '')}.${format}`;
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
