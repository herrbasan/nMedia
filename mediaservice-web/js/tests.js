const API_BASE = 'http://localhost:3500';

const TEST_DEFINITIONS = {
    health: {
        label: 'Health Check',
        description: 'Verify the Media Service is running and all processors are ready.',
        endpoint: 'GET /health',
        expected: 'Status "ok" with image, audio, video processors all "ready"',
    },
    image: {
        label: 'Image Processor',
        description: 'Resize a PNG image to max 256px, convert to JPEG at quality 80.',
        endpoint: 'POST /v1/process/image',
        inputFile: 'tests/assets/images/116.png',
        params: { max_dimension: 256, quality: 80, format: 'jpeg' },
        expected: 'Valid JPEG base64 output, smaller than original',
    },
    audio: {
        label: 'Audio Processor',
        description: 'Convert WAV to MP3, resample to 16kHz mono (optimal for STT).',
        endpoint: 'POST /v1/process/audio',
        inputFile: 'tests/assets/audio/Vangengel.wav',
        params: { sample_rate: 16000, channels: 1, format: 'mp3' },
        expected: 'Valid MP3 base64 output, significantly smaller than original',
    },
    video: {
        label: 'Video Processor',
        description: 'Extract audio track from MOV video as MP3.',
        endpoint: 'POST /v1/process/video',
        inputFile: 'tests/assets/videos/IMG_0104.MOV',
        params: { mode: 'extract_audio', format: 'mp3' },
        expected: 'Valid MP3 base64 output from video audio track',
    },
};

export function initTestsPage(element, nui) {
    console.log('tests init');

    const resultsSection = element.querySelector('#test-results-section');
    const testSummary = element.querySelector('#test-summary');
    const testResults = element.querySelector('#test-results');
    const runAllBtn = element.querySelector('#run-all-tests-btn');
    const testHealthBtn = element.querySelector('#test-health-btn');
    const testImageBtn = element.querySelector('#test-image-btn');
    const testAudioBtn = element.querySelector('#test-audio-btn');
    const testVideoBtn = element.querySelector('#test-video-btn');

    console.log('Buttons found:', {
        runAll: !!runAllBtn,
        health: !!testHealthBtn,
        image: !!testImageBtn,
        audio: !!testAudioBtn,
        video: !!testVideoBtn,
    });

    let testResultsData = [];

    runAllBtn?.addEventListener('click', () => {
        console.log('Run all clicked');
        runAllTests();
    });
    testHealthBtn?.addEventListener('click', () => {
        console.log('Health clicked');
        runTest('health');
    });
    testImageBtn?.addEventListener('click', () => {
        console.log('Image clicked');
        runTest('image');
    });
    testAudioBtn?.addEventListener('click', () => {
        console.log('Audio clicked');
        runTest('audio');
    });
    testVideoBtn?.addEventListener('click', () => {
        console.log('Video clicked');
        runTest('video');
    });

    async function runAllTests() {
        testResultsData = [];
        clearResults();
        resultsSection.style.display = 'block';

        addTestResult('health', 'running', 'Running...');
        await runTest('health', false);

        addTestResult('image', 'running', 'Running...');
        await runTest('image', false);

        addTestResult('audio', 'running', 'Running...');
        await runTest('audio', false);

        addTestResult('video', 'running', 'Running...');
        await runTest('video', false);

        updateSummary();
    }

    async function runTest(testName, updateSummaryFlag = true) {
        const startTime = performance.now();
        try {
            let result;
            switch (testName) {
                case 'health': result = await testHealth(); break;
                case 'image': result = await testImage(); break;
                case 'audio': result = await testAudio(); break;
                case 'video': result = await testVideo(); break;
            }
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
            updateTestResult(testName, 'pass', { elapsed, details: result });
        } catch (error) {
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
            updateTestResult(testName, 'fail', { elapsed, error: error.message });
        }
        if (updateSummaryFlag) updateSummary();
    }

    async function testHealth() {
        const response = await fetch(`${API_BASE}/health`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.status !== 'ok') throw new Error(`Service status: ${data.status}`);
        const processors = data.processors || {};
        const notReady = Object.entries(processors).filter(([, s]) => s !== 'ready');
        if (notReady.length > 0) {
            throw new Error(`Not ready: ${notReady.map(([k]) => k).join(', ')}`);
        }
        return { status: data.status, processors };
    }

    async function testImage() {
        const testFile = await fetchTestFile(TEST_DEFINITIONS.image.inputFile);
        if (!testFile) throw new Error('Test file not found');

        const formData = new FormData();
        formData.append('file', testFile, testFile.name);
        formData.append('max_dimension', '256');
        formData.append('quality', '80');
        formData.append('format', 'jpeg');
        formData.append('response_type', 'base64');

        const response = await fetch(`${API_BASE}/v1/process/image`, { method: 'POST', body: formData });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);

        const data = await response.json();
        if (!data.base64) throw new Error('No base64 in response');
        if (!data.processed_size_bytes) throw new Error('Processed size is 0');

        const originalSize = data.original_size_bytes || 0;
        const processedSize = data.processed_size_bytes || 0;
        const savings = originalSize > 0 ? ((originalSize - processedSize) / originalSize * 100).toFixed(1) : '0.0';

        return {
            originalSize,
            processedSize,
            savings: `${savings}%`,
            outputFormat: data.format,
            outputDimensions: `${data.width}x${data.height}`,
        };
    }

    async function testAudio() {
        const testFile = await fetchTestFile(TEST_DEFINITIONS.audio.inputFile);
        if (!testFile) throw new Error('Test file not found');

        const formData = new FormData();
        formData.append('file', testFile, testFile.name);
        formData.append('sample_rate', '16000');
        formData.append('channels', '1');
        formData.append('format', 'mp3');
        formData.append('response_type', 'base64');

        const response = await fetch(`${API_BASE}/v1/process/audio`, { method: 'POST', body: formData });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);

        const data = await response.json();
        if (!data.base64) throw new Error('No base64 in response');
        if (!data.processed_size_bytes) throw new Error('Processed size is 0');

        const originalSize = data.original_size_bytes || 0;
        const processedSize = data.processed_size_bytes || 0;
        const savings = originalSize > 0 ? ((originalSize - processedSize) / originalSize * 100).toFixed(1) : '0.0';

        return {
            originalSize,
            processedSize,
            savings: `${savings}%`,
            outputFormat: data.format,
            outputSampleRate: `${data.sample_rate} Hz`,
            outputChannels: data.channels === 1 ? 'Mono' : 'Stereo',
        };
    }

    async function testVideo() {
        const testFile = await fetchTestFile(TEST_DEFINITIONS.video.inputFile);
        if (!testFile) throw new Error('Test file not found');

        const formData = new FormData();
        formData.append('file', testFile, testFile.name);
        formData.append('mode', 'extract_audio');
        formData.append('format', 'mp3');
        formData.append('response_type', 'base64');

        const response = await fetch(`${API_BASE}/v1/process/video`, { method: 'POST', body: formData });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);

        const data = await response.json();
        if (!data.base64) throw new Error('No base64 in response');
        if (!data.output_size_bytes && !data.processed_size_bytes) throw new Error('Output size is 0');

        const originalSize = data.original_size_bytes || 0;
        const processedSize = data.output_size_bytes || data.processed_size_bytes || 0;

        return {
            originalSize,
            processedSize,
            outputFormat: data.format,
            mode: data.mode,
        };
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

    function addTestResult(name, status, data) {
        testResultsData.push({ name, status, data });
        renderResults();
    }

    function updateTestResult(name, status, data) {
        const existing = testResultsData.find(r => r.name === name && r.status === 'running');
        if (existing) {
            existing.status = status;
            existing.data = data;
        } else {
            testResultsData.push({ name, status, data });
        }
        renderResults();
    }

    function clearResults() {
        testResultsData = [];
        renderResults();
    }

    function updateSummary() {
        const passed = testResultsData.filter(r => r.status === 'pass').length;
        const failed = testResultsData.filter(r => r.status === 'fail').length;
        const running = testResultsData.filter(r => r.status === 'running').length;

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
            ${running > 0 ? `
            <div style="flex: 1; min-width: 100px; padding: 0.75rem; background: var(--nui-surface-2); border-radius: 8px; text-align: center;">
                <div style="font-size: 1.5rem; font-weight: 700; color: var(--nui-info, #2196f3);">${running}</div>
                <div style="color: var(--nui-text-muted); font-size: 0.85rem;">Running</div>
            </div>` : ''}
        `;
    }

    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    function renderResults() {
        testResults.innerHTML = testResultsData.map(r => {
            const def = TEST_DEFINITIONS[r.name] || {};
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
                if (d.originalSize) rows.push(`<span style="color: var(--nui-text-muted);">Input:</span> ${formatBytes(d.originalSize)}`);
                if (d.processedSize) rows.push(`<span style="color: var(--nui-text-muted);">Output:</span> ${formatBytes(d.processedSize)}`);
                if (d.savings) rows.push(`<span style="color: var(--nui-text-muted);">Savings:</span> ${d.savings}`);
                if (d.outputFormat) rows.push(`<span style="color: var(--nui-text-muted);">Format:</span> ${d.outputFormat}`);
                if (d.outputDimensions) rows.push(`<span style="color: var(--nui-text-muted);">Size:</span> ${d.outputDimensions}`);
                if (d.outputSampleRate) rows.push(`<span style="color: var(--nui-text-muted);">Sample Rate:</span> ${d.outputSampleRate}`);
                if (d.outputChannels) rows.push(`<span style="color: var(--nui-text-muted);">Channels:</span> ${d.outputChannels}`);
                if (d.processors) {
                    const proc = Object.entries(d.processors).map(([k, v]) => `${k}: ${v}`).join(', ');
                    rows.push(`<span style="color: var(--nui-text-muted);">Processors:</span> ${proc}`);
                }
                detailsHtml = `<div style="margin-top: 0.5rem; font-size: 0.85rem; display: flex; gap: 1rem; flex-wrap: wrap;">${rows.map(r => `<span>${r}</span>`).join('')}</div>`;
            } else if (r.status === 'fail' && r.data?.error) {
                detailsHtml = `<div style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--nui-danger, #f44336);">${r.data.error}</div>`;
            }

            return `
                <div style="padding: 0.75rem; border-bottom: 1px solid var(--nui-border, #e0e0e0);">
                    <div style="display: flex; align-items: center; gap: 0.75rem;">
                        <span style="font-size: 1.2rem; color: ${color}; font-weight: 700; min-width: 24px;">${icon}</span>
                        <span style="font-weight: 600; min-width: 120px;">${def.label || r.name}</span>
                        <span style="color: ${color}; font-size: 0.8rem; font-weight: 600; min-width: 50px; padding: 0.15rem 0.5rem; border-radius: 4px; background: ${color}15;">${label}</span>
                    </div>
                    <div style="margin-left: 2.5rem; margin-top: 0.25rem; font-size: 0.85rem; color: var(--nui-text-muted);">${def.description || ''}</div>
                    <div style="margin-left: 2.5rem; margin-top: 0.25rem; font-size: 0.8rem; color: var(--nui-text-muted);">
                        <span style="color: var(--nui-text-secondary);">Endpoint:</span> ${def.endpoint || ''}
                        ${def.inputFile ? ` &middot; <span style="color: var(--nui-text-secondary);">File:</span> ${def.inputFile.split('/').pop()}` : ''}
                    </div>
                    <div style="margin-left: 2.5rem; margin-top: 0.25rem; font-size: 0.8rem; color: var(--nui-text-muted);">
                        <span style="color: var(--nui-text-secondary);">Expected:</span> ${def.expected || ''}
                    </div>
                    ${detailsHtml}
                </div>
            `;
        }).join('');
    }
}
