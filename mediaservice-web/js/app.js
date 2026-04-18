import { nui } from '../../modules/nui_wc2/NUI/nui.js';
import { initAudioPage } from './audio.js';
import { initImagePage } from './image.js';
import { initVideoPage } from './video.js';
import { initSettingsPage } from './settings.js';
import { initTestsPage } from './tests.js';
import { initTransportTestsPage } from './transport-tests.js';


window.app = {
    'initAudioPage': initAudioPage,
    'initImagePage': initImagePage,
    'initVideoPage': initVideoPage,
    'initSettingsPage': initSettingsPage,
    'initTestsPage': initTestsPage,
    'initTransportTestsPage': initTransportTestsPage,
}

const navigationData = [
    {
        "label": "Media Processors",
        "icon": "image",
        "items": [
            {
                "label": "Image",
                "href": "#page=image"
            },
            {
                "label": "Audio",
                "href": "#page=audio"
            },
            {
                "label": "Video",
                "href": "#page=video"
            }
        ]
    },
    {
        "label": "Settings",
        "icon": "settings",
        "items": [
            {
                "label": "Preferences",
                "href": "#page=settings"
            }
        ]
    },
    {
        "label": "Testing",
        "icon": "bug_report",
        "items": [
            {
                "label": "API Tests",
                "href": "#page=tests"
            },
            {
                "label": "Transport Tests",
                "href": "#page=transport-tests"
            }
        ]
    }
];

const linkList = document.querySelector('nui-link-list');
if (linkList) {
    linkList.loadData(navigationData);
}

nui.setupRouter({
    container: 'nui-main',
    navigation: 'nui-sidebar',
    basePath: 'pages',
    defaultPage: 'image'
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

console.log('mediaservice-web initialized');
