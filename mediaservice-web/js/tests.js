const API_BASE = 'http://localhost:3500';

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

    let testFiles = { image: null, audio: null, video: null };
    let testResultsData = [];

    runAllBtn?.addEventListener('click', () => runAllTests());
    testHealthBtn?.addEventListener('click', () => runTest('health'));
    testImageBtn?.addEventListener('click', () => runTest('image'));
    testAudioBtn?.addEventListener('click', () => runTest('audio'));
    testVideoBtn?.addEventListener('click', () => runTest('video'));

    async function runAllTests() {
        testResultsData = [];
        clearResults();
        resultsSection.style.display = 'block';

        addTestResult('health', 'running', 'Running health check...');
        await runTest('health', false);

        addTestResult('image', 'running', 'Running image processor test...');
        await runTest('image', false);

        addTestResult('audio', 'running', 'Running audio processor test...');
        await runTest('audio', false);

        addTestResult('video', 'running', 'Running video processor test...');
        await runTest('video', false);

        updateSummary();
    }

    async function runTest(testName, updateSummaryFlag = true) {
        const startTime = performance.now();
        try {
            switch (testName) {
                case 'health':
                    await testHealth();
                    break;
                case 'image':
                    await testImage();
                    break;
                case 'audio':
                    await testAudio();
                    break;
                case 'video':
                    await testVideo();
                    break;
            }
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
            updateTestResult(testName, 'pass', `Completed in ${elapsed}s`);
        } catch (error) {
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
            updateTestResult(testName, 'fail', error.message);
        }
        if (updateSummaryFlag) updateSummary();
    }

    async function testHealth() {
        const response = await fetch(`${API_BASE}/health`);
        if (!response.ok) throw new Error(`Health check failed: HTTP ${response.status}`);
        const data = await response.json();
        if (data.status !== 'ok') throw new Error(`Service status: ${data.status}`);
        const processors = data.processors || {};
        const allReady = Object.values(processors).every(s => s === 'ready');
        if (!allReady) {
            const notReady = Object.entries(processors).filter(([, s]) => s !== 'ready').map(([k]) => k).join(', ');
            throw new Error(`Processors not ready: ${notReady}`);
        }
    }

    async function testImage() {
        const testImage = await fetchTestFile('tests/assets/images/116.png');
        if (!testImage) throw new Error('Test image not found at tests/assets/images/116.png');

        const formData = new FormData();
        formData.append('file', testImage, '116.png');
        formData.append('max_dimension', '256');
        formData.append('quality', '80');
        formData.append('format', 'jpeg');
        formData.append('response_type', 'base64');

        const response = await fetch(`${API_BASE}/v1/process/image`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Image processing failed: HTTP ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        if (!data.base64) throw new Error('No base64 data in response');
        if (!data.processed_size_bytes || data.processed_size_bytes === 0) throw new Error('Processed size is 0');
    }

    async function testAudio() {
        const testAudio = await fetchTestFile('tests/assets/audio/Vangengel.wav');
        if (!testAudio) throw new Error('Test audio not found at tests/assets/audio/Vangengel.wav');

        const formData = new FormData();
        formData.append('file', testAudio, 'Vangengel.wav');
        formData.append('sample_rate', '16000');
        formData.append('channels', '1');
        formData.append('format', 'mp3');
        formData.append('response_type', 'base64');

        const response = await fetch(`${API_BASE}/v1/process/audio`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Audio processing failed: HTTP ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        if (!data.base64) throw new Error('No base64 data in response');
        if (!data.processed_size_bytes || data.processed_size_bytes === 0) throw new Error('Processed size is 0');
    }

    async function testVideo() {
        const testVideo = await fetchTestFile('tests/assets/videos/IMG_0104.MOV');
        if (!testVideo) throw new Error('Test video not found at tests/assets/videos/IMG_0104.MOV');

        const formData = new FormData();
        formData.append('file', testVideo, 'IMG_0104.MOV');
        formData.append('mode', 'extract_audio');
        formData.append('format', 'mp3');
        formData.append('response_type', 'base64');

        const response = await fetch(`${API_BASE}/v1/process/video`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Video processing failed: HTTP ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        if (!data.base64) throw new Error('No base64 data in response');
        if (!data.processed_size_bytes || data.processed_size_bytes === 0) throw new Error('Processed size is 0');
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

    function addTestResult(name, status, message) {
        testResultsData.push({ name, status, message });
        renderResults();
    }

    function updateTestResult(name, status, message) {
        const existing = testResultsData.find(r => r.name === name && r.status === 'running');
        if (existing) {
            existing.status = status;
            existing.message = message;
        } else {
            testResultsData.push({ name, status, message });
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
        const total = testResultsData.length;

        testSummary.innerHTML = `
            <div style="flex: 1; min-width: 100px; padding: 0.75rem; background: var(--nui-surface-2); border-radius: 8px; text-align: center;">
                <div style="font-size: 1.5rem; font-weight: 700;">${total}</div>
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

    function renderResults() {
        testResults.innerHTML = testResultsData.map(r => {
            const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '⟳';
            const color = r.status === 'pass' ? 'var(--nui-success, #4caf50)' :
                          r.status === 'fail' ? 'var(--nui-danger, #f44336)' :
                          'var(--nui-info, #2196f3)';
            const label = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'RUNNING';
            return `
                <div style="display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; border-bottom: 1px solid var(--nui-border, #e0e0e0);">
                    <span style="font-size: 1.2rem; color: ${color}; font-weight: 700; min-width: 24px;">${icon}</span>
                    <span style="font-weight: 600; min-width: 80px; text-transform: capitalize;">${r.name}</span>
                    <span style="color: ${color}; font-size: 0.85rem; font-weight: 600; min-width: 60px;">${label}</span>
                    <span style="color: var(--nui-text-muted); font-size: 0.85rem; flex: 1;">${r.message}</span>
                </div>
            `;
        }).join('');
    }
}
