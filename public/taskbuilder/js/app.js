import { nui } from '../../modules/nui_wc2/NUI/nui.js';
import { initTestsPage } from './tests.js';
import { initTransportTestsPage } from './transport-tests.js';
import { initAudioTasksPage } from './audio-tasks.js';
import { initImageTasksPage } from './image-tasks.js';
import { initVideoTasksPage } from './video-tasks.js';


window.app = {
    'initTestsPage': initTestsPage,
    'initTransportTestsPage': initTransportTestsPage,
    'initAudioTasksPage': initAudioTasksPage,
    'initImageTasksPage': initImageTasksPage,
    'initVideoTasksPage': initVideoTasksPage,
}

const navigationData = [
    {
        "label": "Task Builder",
        "icon": "build",
        "items": [
            { "label": "Image Tasks", "href": "#page=image-tasks" },
            { "label": "Audio Tasks", "href": "#page=audio-tasks" },
            { "label": "Video Tasks", "href": "#page=video-tasks" }
        ]
    },
    {
        "label": "Testing",
        "icon": "bug_report",
        "items": [
            { "label": "API Tests", "href": "#page=tests" },
            { "label": "Transport Tests", "href": "#page=transport-tests" }
        ]
    }
];

const linkList = document.querySelector('nui-link-list');
if (linkList) {
    requestAnimationFrame(() => {
        linkList.loadData(navigationData);
    });
} else {
    // Retry if component not ready yet
    const observer = new MutationObserver(() => {
        const ll = document.querySelector('nui-link-list');
        if (ll) {
            ll.loadData(navigationData);
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

nui.setupRouter({
    container: 'nui-main',
    navigation: 'nui-sidebar',
    basePath: 'pages',
    defaultPage: 'image-tasks'
});

document.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    
    const actionSpec = actionEl.dataset.action;
    const [actionPart] = actionSpec.split('@');
    const [action, param] = actionPart.split(':');

    switch (action) {
        case 'toggle-sidebar': {
            const app = document.querySelector('nui-app');
            if (app?.toggleSidebar) {
                app.toggleSidebar(param || 'left');
            }
            break;
        }
        case 'toggle-theme':
            toggleTheme();
            break;
        case 'scroll-to-top':
            document.querySelector('nui-content')?.scrollTo({ top: 0, behavior: 'smooth' });
            break;
    }
});

function toggleTheme() {
    const root = document.documentElement;
    const current = root.style.colorScheme || 
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    root.style.colorScheme = current === 'dark' ? 'light' : 'dark';
}

// Footer health check
const footerInfo = document.getElementById('appFooterInfo');
if (footerInfo) {
    const API_BASE = 'http://localhost:3501';
    fetch(`${API_BASE}/health`)
        .then(res => {
            if (res.ok) {
                footerInfo.textContent = 'Media Service Connected ✓';
                footerInfo.style.color = 'var(--nui-success, #4caf50)';
            } else {
                footerInfo.textContent = 'Media Service Unavailable';
                footerInfo.style.color = 'var(--nui-danger, #f44336)';
            }
        })
        .catch(() => {
            footerInfo.textContent = 'Media Service Unavailable';
            footerInfo.style.color = 'var(--nui-danger, #f44336)';
        });
}

console.log('taskbuilder initialized');
