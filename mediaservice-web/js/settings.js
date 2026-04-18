const API_BASE = 'http://localhost:3501';

export function initSettingsPage(element, nui) {
    console.log('settings init');
    
    const testBtn = element.querySelector('#test-connection-btn');
    const statusDiv = element.querySelector('#connection-status');
    const apiUrlInput = element.querySelector('#api-base-url');

    if (apiUrlInput) apiUrlInput.value = API_BASE;

    testBtn?.addEventListener('click', async () => {
        testBtn.setLoading(true);
        if (statusDiv) statusDiv.style.display = 'none';

        try {
            const response = await fetch(`${API_BASE}/health`, { method: 'GET' });
            const healthy = response.ok;

            testBtn.setLoading(false);

            if (statusDiv) {
                statusDiv.style.display = 'block';
                if (healthy) {
                    statusDiv.style.background = 'var(--nui-success-bg, #e8f5e9)';
                    statusDiv.style.color = 'var(--nui-success, #2e7d32)';
                    statusDiv.style.border = '1px solid var(--nui-success, #2e7d32)';
                    statusDiv.innerHTML = '<nui-icon name="done">✓</nui-icon> <strong>Connected!</strong> Media Service is running and responding.';
                } else {
                    statusDiv.style.background = 'var(--nui-danger-bg, #ffebee)';
                    statusDiv.style.color = 'var(--nui-danger, #c62828)';
                    statusDiv.style.border = '1px solid var(--nui-danger, #c62828)';
                    statusDiv.innerHTML = `<nui-icon name="warning">⚠</nui-icon> <strong>Connection Failed</strong><br>HTTP ${response.status}: ${response.statusText}`;
                }
            }
        } catch (error) {
            testBtn.setLoading(false);
            if (statusDiv) {
                statusDiv.style.display = 'block';
                statusDiv.style.background = 'var(--nui-danger-bg, #ffebee)';
                statusDiv.style.color = 'var(--nui-danger, #c62828)';
                statusDiv.style.border = '1px solid var(--nui-danger, #c62828)';
                statusDiv.innerHTML = `<nui-icon name="warning">⚠</nui-icon> <strong>Connection Failed</strong><br>${error.message || 'Could not reach Media Service on port 3500'}`;
            }
        }
    });
}
