import { nui } from '../../modules/nui_wc2/NUI/nui.js';
import { api } from './api-client.js';

// Global action handler
document.addEventListener('click', (e) => {
	const actionEl = e.target.closest('[data-action]');
	if (!actionEl) return;

	const actionSpec = actionEl.dataset.action;
	const [actionPart] = actionSpec.split('@');
	const [action, param] = actionPart.split(':');

	switch (action) {
		case 'toggle-sidebar':
			document.querySelector('nui-app')?.toggleSidebar?.(param || 'left');
			break;
		case 'toggle-theme': {
			const current = document.documentElement.style.colorScheme || 'light';
			const next = current === 'dark' ? 'light' : 'dark';
			document.documentElement.style.colorScheme = next;
			localStorage.setItem('ms_theme', next);
			break;
		}
	}
});

// Restore theme preference
const savedTheme = localStorage.getItem('ms_theme');
if (savedTheme) {
	document.documentElement.style.colorScheme = savedTheme;
}

// WebSocket connection management
let ws = null;
let wsReconnectTimer = null;

function updateConnectionStatus(status) {
	const dot = document.getElementById('connection-status');
	if (!dot) return;
	dot.className = 'status-dot ' + status;
	dot.title = status === 'connected' ? 'WebSocket connected' : status === 'connecting' ? 'Connecting...' : 'WebSocket disconnected';
}

function connectWebSocket() {
	if (ws?.readyState === WebSocket.OPEN) return;
	updateConnectionStatus('connecting');

	try {
		ws = api.connectWebSocket(
			(msg) => {
				window.dispatchEvent(new CustomEvent('ws-message', { detail: msg }));
			},
			() => updateConnectionStatus('connected'),
			() => {
				updateConnectionStatus('disconnected');
				wsReconnectTimer = setTimeout(connectWebSocket, 5000);
			}
		);
	} catch {
		updateConnectionStatus('disconnected');
	}
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
	if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
	if (ws) ws.close();
});

// Navigation
const navigationData = [
	{ label: 'Dashboard', href: '#page=dashboard', icon: 'dashboard' },
	{ label: 'Task Explorer', href: '#page=task-explorer', icon: 'science' },
	{ label: 'Job Monitor', href: '#page=job-monitor', icon: 'list' },
	{ label: 'System Tests', href: '#page=system-tests', icon: 'verified' },
	{ label: 'Cache Manager', href: '#page=cache-manager', icon: 'storage' },
];

const sideNav = document.getElementById('main-navigation');
if (sideNav && sideNav.loadData) {
	sideNav.loadData(navigationData);
}

// Router
nui.setupRouter({
	container: 'nui-content nui-main',
	navigation: 'nui-sidebar#nav-sidebar',
	basePath: 'pages',
	defaultPage: 'dashboard',
});

// Initial connection
connectWebSocket();

// Expose api globally for page scripts
window.api = api;
window.nui = nui;
