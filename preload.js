const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();

contextBridge.exposeInMainWorld('terrones', {
  runtime: {
    retry: () => ipcRenderer.invoke('runtime:retry'),
    getStatus: () => ipcRenderer.invoke('runtime:status'),
    getDiagnostics: () => ipcRenderer.invoke('runtime:diagnostics'),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('runtime:status-changed', listener);
      listeners.set(callback, listener);
    },
    removeStatusListener: (callback) => {
      const listener = listeners.get(callback);
      if (listener) ipcRenderer.removeListener('runtime:status-changed', listener);
      listeners.delete(callback);
    },
  },
  window: {
    close: () => ipcRenderer.send('close-window'),
  },
  search: {
    perform: (query) => ipcRenderer.send('perform-search', query),
    onSuccess: (callback) => ipcRenderer.on('download-success', (_event, value) => callback(value)),
    onError: (callback) => ipcRenderer.on('download-error', (_event, value) => callback(value)),
  },
});

// Indicador permanente dentro del POS local. No expone Node ni operaciones
// arbitrarias al contenido PHP.
window.addEventListener('DOMContentLoaded', () => {
  if (window.location.origin !== 'http://127.0.0.1:8080' && window.location.origin !== 'http://localhost:8080') return;
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.id = 'terrones-runtime-badge';
  badge.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:100000;border:0;border-radius:999px;padding:8px 13px;color:white;font:600 12px Segoe UI;background:#64748b;box-shadow:0 3px 12px #0004;cursor:pointer';
  badge.textContent = 'Nube: comprobando…';
  badge.addEventListener('click', () => ipcRenderer.send('runtime:show-status'));
  document.body.appendChild(badge);

  const refresh = async () => {
    const status = await ipcRenderer.invoke('runtime:status');
    const sync = status.sync || status;
    const labels = { synced: 'Nube: al día', catching_up: 'Nube: actualizando', connecting: 'Nube: conectando', offline: 'Nube: sin conexión', error: 'Nube: error', disabled: 'Nube: no configurada' };
    const colors = { synced: '#15803d', catching_up: '#d97706', connecting: '#2563eb', offline: '#475569', error: '#b91c1c', disabled: '#64748b' };
    badge.textContent = labels[sync.state] || 'Nube: sin estado';
    badge.style.background = colors[sync.state] || '#64748b';
    badge.title = sync.message || '';
  };
  refresh().catch(() => {});
  setInterval(() => refresh().catch(() => {}), 30000);
});
