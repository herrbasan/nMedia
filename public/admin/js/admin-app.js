import { nui } from '../../modules/nui_wc2/NUI/nui.js';
import { initMonitoringPage } from './pages/monitoring.js';
import { adminWs } from './ws-client.js';

window.adminApp = {
    initMonitoringPage,
};

const navigationData = [
    { label: 'Monitoring', icon: 'dashboard', href: '#page=monitoring' },
];

const linkList = document.querySelector('nui-link-list');
if (linkList) {
    linkList.loadData(navigationData);
}

nui.setupRouter({
    container: 'nui-main',
    navigation: 'nui-sidebar',
    basePath: 'pages',
    defaultPage: 'monitoring'
});

document.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const [action] = actionEl.dataset.action.split(':');
    switch (action) {
        case 'toggle-sidebar': {
            const app = document.querySelector('nui-app');
            if (app?.toggleSidebar) app.toggleSidebar('left');
            break;
        }
        case 'toggle-theme':
            toggleTheme();
            break;
    }
});

function toggleTheme() {
    const root = document.documentElement;
    const current = root.style.colorScheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    root.style.colorScheme = current === 'dark' ? 'light' : 'dark';
}

// Connect WebSocket on load
adminWs.connect().catch(() => {});
