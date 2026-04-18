const API_BASE = 'http://localhost:3501';

export function initAudioPage(element, nui) {
    console.log('audio init');
    let currentFile = null;
    let processedData = null;
    let sourceMetadata = null;

    const selectBtn = element.querySelector('#select-audio-btn');
    const optionsSection = element.querySelector('#audio-options');
    const processBtn = element.querySelector('#process-audio-btn');
    const processingDialog = element.querySelector('#audio-processing-dialog');
    const downloadBtn = element.querySelector('#audio-download-btn');

    selectBtn?.addEventListener('nui-file-selected', (e) => {
        if (e.detail.files.length > 0) {
            handleFile(e.detail.files[0]).catch(err => {
                console.error('handleFile error:', err);
            });
        }
    });

    async function handleFile(file) {
        currentFile = file;
        
        if (optionsSection) {
            optionsSection.style.display = 'block';
        }
        
        updateFileInfo(file);
        await probeAudio(file);
        optionsSection?.scrollIntoView({ behavior: 'smooth' });
    }

    function updateFileInfo(file) {
        const fileInfo = element.querySelector('#file-info');
        if (!fileInfo) return;
        
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

    async function probeAudio(file) {
        const sourceMetadataDiv = element.querySelector('#source-metadata');
        const sourceDetails = element.querySelector('#source-details');
        
        if (!sourceMetadataDiv || !sourceDetails) return;
        
        while (sourceDetails.firstChild) {
            sourceDetails.removeChild(sourceDetails.firstChild);
        }
        sourceMetadataDiv.style.display = 'none';
        
        
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(`${API_BASE}/v1/audio/probe`, {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Probe failed:', response.status, errorText);
            return;
        }
        
        const result = await response.json();
        console.log('=== AUDIO PROBE RESPONSE ===');
        console.log('Status:', response.status);
        console.log('Headers:', Object.fromEntries(response.headers.entries()));
        console.log('Full response body:', JSON.stringify(result, null, 2));
        console.log('===========================');
        sourceMetadata = result.metadata;
        
        if (!sourceMetadata) return;
        
        const sampleRate = sourceMetadata.sampleRate ? `${sourceMetadata.sampleRate} Hz` : 'Unknown';
        const bitDepth = sourceMetadata.bitDepth ? `${sourceMetadata.bitDepth}-bit` : 'N/A (lossy)';
        const channelLayout = sourceMetadata.channels === 1 ? 'Mono' : 
                                sourceMetadata.channels === 2 ? 'Stereo' : 
                                `${sourceMetadata.channels} channels`;
        
        const stats = [
            { label: 'Sample Rate', value: sampleRate },
            { label: 'Bit Depth', value: bitDepth },
            { label: 'Channel Layout', value: channelLayout }
        ];
        
        stats.forEach(stat => {
            const card = document.createElement('div');
            card.style.cssText = 'flex: 1; min-width: 120px;';
            
            const label = document.createElement('div');
            label.style.cssText = 'color: var(--nui-text-muted); font-size: 0.85rem;';
            label.textContent = stat.label;
            
            const value = document.createElement('div');
            value.style.cssText = 'font-weight: 600;';
            value.textContent = stat.value;
            
            card.appendChild(label);
            card.appendChild(value);
            sourceDetails.appendChild(card);
        });
        
        sourceMetadataDiv.style.display = 'block';
    }

    processBtn?.addEventListener('click', async () => {
        if (!currentFile) return;

        processingDialog?.showModal();
        const startTime = performance.now();

        const sampleRateSelect = element.querySelector('#sample-rate-select select');
        const channelsSelect = element.querySelector('#channels-select select');
        const formatSelect = element.querySelector('#audio-format-select select');
        
        const options = {
            sample_rate: sampleRateSelect?.value || '16000',
            channels: channelsSelect?.value || '1',
            format: formatSelect?.value || 'mp3'
        };

        try {
            const formData = new FormData();
            formData.append('file', currentFile);
            formData.append('sample_rate', options.sample_rate);
            formData.append('channels', options.channels);
            formData.append('format', options.format);
            formData.append('response_type', 'base64');

            const response = await fetch(`${API_BASE}/v1/process/audio`, {
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
                    content: `Audio processed successfully! Saved ${formatFileSize(data.original_size_bytes - data.processed_size_bytes)}`,
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
        const placeholder = element.querySelector('#audio-result-placeholder');
        const resultCard = element.querySelector('#audio-result-card');
        
        if (placeholder) placeholder.style.display = 'none';
        if (resultCard) resultCard.style.display = 'block';

        const formatSelect = element.querySelector('#audio-format-select select');
        const format = formatSelect?.value || 'mp3';
        const mimeTypes = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' };
        const mimeType = mimeTypes[format] || `audio/${format}`;
        
        const resultDiv = element.querySelector('#audio-processed-result');
        if (resultDiv) {
            while (resultDiv.firstChild) {
                resultDiv.removeChild(resultDiv.firstChild);
            }
            
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
        }

        const info = element.querySelector('#audio-result-info');
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
                { label: 'Output', value: `${data.sample_rate} Hz, ${data.channels === 1 ? 'Mono' : 'Stereo'}` },
                { label: 'Processing Time', value: `${elapsed}s` }
            ];
            
            if (data.source_metadata) {
                rows.splice(3, 0, {
                    label: 'Source',
                    value: `${data.source_metadata.sampleRate} Hz, ${data.source_metadata.channels === 1 ? 'Mono' : 'Stereo'}`
                });
            }
            
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
        link.download = `processed_${currentFile.name.replace(/\.[^/.]+$/, '')}.${processedData.format || 'mp3'}`;
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
