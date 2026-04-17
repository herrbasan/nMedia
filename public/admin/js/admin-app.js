import { nui } from '../../modules/nui_wc2/NUI/nui.js';
import { initQueueMonitorPage } from './pages/queue-monitor.js';
import { initTaskBuilderPage } from './pages/task-builder.js';
import { initDashboardPage } from './pages/dashboard.js';
import { adminWs } from './ws-client.js';

window.adminApp = {
    initQueueMonitorPage,
    initTaskBuilderPage,
    initDashboardPage,
};

const navigationData = [
    {
        label: 'Overview',
        icon: 'dashboard',
        items: [
            { label: 'Dashboard', href: '#page=dashboard' },
        ]
    },
    {
        label: 'Operations',
        icon: 'queue',
        items: [
            { label: 'Queue Monitor', href: '#page=queue-monitor' },
            { label: 'Task Builder', href: '#page=task-builder' },
        ]
    },
];

const linkList = document.querySelector('nui-link-list');
if (linkList) {
    linkList.loadData(navigationData);
}

nui.setupRouter({
    container: 'nui-main',
    navigation: 'nui-sidebar',
    basePath: 'pages',
    defaultPage: 'dashboard'
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
