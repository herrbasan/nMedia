/**
 * Media Service Admin - Main Application
 * 
 * Uses NUI's built-in content loading and router patterns.
 */

import { nui } from '/modules/nui_wc2/NUI/nui.js';

// ============================================
// API Client
// ============================================
class MediaServiceAPI {
  async request(endpoint, options = {}) {
    const url = `${endpoint}`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      ...options,
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }
    
    return response.json();
  }

  getHealth() { return this.request('/health'); }
  getTasks() { return this.request('/v1/tasks'); }
  getTask(taskId) { return this.request(`/v1/tasks/${taskId}`); }
  getTaskResult(taskId) { return this.request(`/v1/tasks/${taskId}/result`); }
  cancelTask(taskId) { return this.request(`/v1/tasks/${taskId}`, { method: 'DELETE' }); }
  getTaskStats() { return this.request('/v1/tasks/stats'); }
  getAssets() { return this.request('/v1/assets'); }

  processImage(formData) {
    return this.request('/v1/process/image', { method: 'POST', body: formData });
  }
  processAudio(formData) {
    return this.request('/v1/process/audio', { method: 'POST', body: formData });
  }
  processVideo(formData) {
    return this.request('/v1/process/video', { method: 'POST', body: formData });
  }

  createTaskProgressStream(taskId, onProgress) {
    const evtSource = new EventSource(`/v1/process/progress/${taskId}`);
    
    evtSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onProgress(data);
        if (data.status === 'complete' || data.status === 'error') {
          evtSource.close();
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };
    
    evtSource.onerror = () => evtSource.close();
    return evtSource;
  }
}

const api = new MediaServiceAPI();

// ============================================
// Navigation Data
// ============================================
const navigationData = [
  {
    label: 'Overview',
    icon: 'analytics',
    items: [
      { label: 'Dashboard', href: '#page=dashboard', icon: 'analytics' }
    ]
  },
  {
    label: 'Processing Tests',
    icon: 'play',
    items: [
      { label: 'Image Tests', href: '#page=image-tests', icon: 'image' },
      { label: 'Audio Tests', href: '#page=audio-tests', icon: 'headphones' },
      { label: 'Video Tests', href: '#page=video-tests', icon: 'smart_display' }
    ]
  },
  {
    label: 'System',
    icon: 'settings',
    items: [
      { label: 'Task Monitor', href: '#page=task-monitor', icon: 'table_rows' }
    ]
  }
];

// ============================================
// Action Handlers (Event Delegation)
// ============================================
document.addEventListener('click', (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;
  
  const actionSpec = actionEl.dataset.action;
  const [actionPart] = actionSpec.split('@');
  const [action, param] = actionPart.split(':');

  switch (action) {
    case 'toggle-sidebar':
      const app = document.querySelector('nui-app');
      if (app?.toggleSideNav) {
        app.toggleSideNav(param || 'left');
      }
      break;
      
    case 'toggle-theme':
      const current = document.documentElement.style.colorScheme || 'light';
      const newTheme = current === 'dark' ? 'light' : 'dark';
      document.documentElement.style.colorScheme = newTheme;
      localStorage.setItem('nui-theme', newTheme);
      break;
      
    case 'refresh-status':
      updateServiceStatus();
      break;
      
    case 'scroll-to-top':
      document.querySelector('nui-content')?.scrollTo({ top: 0, behavior: 'smooth' });
      break;
      
    case 'process-image':
      processImageTest();
      break;
      
    case 'process-audio':
      processAudioTest();
      break;
      
    case 'process-video':
      processVideoTest();
      break;
      
    case 'cancel-task':
      api.cancelTask(param).then(() => {
        nui.components.banner.show({ content: 'Task cancelled', autoClose: 2000 });
      });
      break;
  }
});

// ============================================
// Service Status
// ============================================
async function updateServiceStatus() {
  const badge = document.getElementById('service-status');
  if (!badge) return;
  
  try {
    const health = await api.getHealth();
    badge.textContent = 'Online';
    badge.setAttribute('priority', 'success');
  } catch (err) {
    badge.textContent = 'Offline';
    badge.setAttribute('priority', 'alert');
  }
}

// ============================================
// Test Processing Functions
// ============================================
async function processImageTest() {
  const fileInput = document.getElementById('image-file');
  const resultsPanel = document.getElementById('image-results');
  
  if (!fileInput?.files?.[0]) {
    nui.components.banner.show({ content: 'Please select an image file', priority: 'alert', autoClose: 3000 });
    return;
  }
  
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('max_dimension', document.getElementById('opt-max-dimension')?.value || '1024');
  formData.append('quality', document.getElementById('opt-quality')?.value || '85');
  formData.append('format', document.getElementById('opt-format')?.value || 'jpeg');
  
  await runTest('image', formData, resultsPanel);
}

async function processAudioTest() {
  const fileInput = document.getElementById('audio-file');
  const resultsPanel = document.getElementById('audio-results');
  
  if (!fileInput?.files?.[0]) {
    nui.components.banner.show({ content: 'Please select an audio file', priority: 'alert', autoClose: 3000 });
    return;
  }
  
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('sample_rate', document.getElementById('opt-sample-rate')?.value || '16000');
  formData.append('channels', document.getElementById('opt-channels')?.value || '1');
  formData.append('format', document.getElementById('opt-audio-format')?.value || 'mp3');
  
  await runTest('audio', formData, resultsPanel);
}

async function processVideoTest() {
  const fileInput = document.getElementById('video-file');
  const resultsPanel = document.getElementById('video-results');
  
  if (!fileInput?.files?.[0]) {
    nui.components.banner.show({ content: 'Please select a video file', priority: 'alert', autoClose: 3000 });
    return;
  }
  
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('mode', document.getElementById('opt-video-mode')?.value || 'extract_audio');
  formData.append('fps', document.getElementById('opt-fps')?.value || '1');
  formData.append('max_dimension', document.getElementById('opt-video-max-dim')?.value || '1024');
  
  await runTest('video', formData, resultsPanel);
}

async function runTest(type, formData, resultsContainer) {
  if (!resultsContainer) return;
  
  resultsContainer.innerHTML = '<nui-progress indeterminate></nui-progress><p>Processing...</p>';
  
  try {
    const result = await api[`process${type.charAt(0).toUpperCase() + type.slice(1)}`](formData);
    
    if (result.taskId) {
      resultsContainer.innerHTML = `
        <nui-card>
          <h4>Task Created</h4>
          <p>Task ID: <code>${result.taskId}</code></p>
          <nui-progress id="task-progress" value="0" max="100"></nui-progress>
          <p id="task-status">Starting...</p>
        </nui-card>
      `;
      
      api.createTaskProgressStream(result.taskId, (data) => {
        const progress = document.getElementById('task-progress');
        const status = document.getElementById('task-status');
        if (progress) progress.value = data.progress || 0;
        if (status) status.textContent = data.message || data.status;
      });
    } else {
      showResult(result, type, resultsContainer);
    }
  } catch (err) {
    resultsContainer.innerHTML = `<nui-card><p class="text-alert">Error: ${err.message}</p></nui-card>`;
  }
}

function showResult(result, type, container) {
  const isImage = type === 'image';
  const preview = isImage && result.metadata?.base64 
    ? `<img src="${result.metadata.base64}" style="max-width: 100%; max-height: 300px;">` 
    : '';
  
  container.innerHTML = `
    <nui-card>
      <h4>Result</h4>
      ${preview}
      <div class="result-meta">
        <p><strong>Original Size:</strong> ${formatBytes(result.metadata?.originalSize)}</p>
        <p><strong>Output Size:</strong> ${formatBytes(result.metadata?.outputSize)}</p>
        ${result.metadata?.dimensions ? `<p><strong>Dimensions:</strong> ${result.metadata.dimensions}</p>` : ''}
        ${result.assetId ? `<a href="/v1/assets/${result.assetId}" download>Download</a>` : ''}
      </div>
    </nui-card>
  `;
}

// ============================================
// Utilities
// ============================================
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============================================
// Initialize
// ============================================
async function init() {
  // Load side navigation
  const sideNav = document.querySelector('nui-sidebar nui-link-list');
  if (sideNav && sideNav.loadData) {
    sideNav.loadData(navigationData);
  }
  
  // Initial status check
  await updateServiceStatus();
  
  // Setup content loading (this enables the router)
  nui.enableContentLoading({
    container: 'nui-content nui-main',
    navigation: 'nui-sidebar',
    basePath: '/admin/pages',
    defaultPage: 'dashboard'
  });
  
  // Restore theme preference
  const savedTheme = localStorage.getItem('nui-theme');
  if (savedTheme) {
    document.documentElement.style.colorScheme = savedTheme;
  }
}

// Wait for DOM ready
document.addEventListener('DOMContentLoaded', init);

// Expose API for page scripts
window.MediaServiceAPI = api;
window.formatBytes = formatBytes;
