const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcLauncher', {
  start: (payload) => ipcRenderer.invoke('launcher:start', payload),
  getVersions: (options) => ipcRenderer.invoke('launcher:versions', options),
  microsoftLogin: () => ipcRenderer.invoke('auth:microsoft-login'),
  microsoftRestore: () => ipcRenderer.invoke('auth:microsoft-restore'),
  microsoftList: () => ipcRenderer.invoke('auth:microsoft-list'),
  microsoftSelect: (accountId) => ipcRenderer.invoke('auth:microsoft-select', accountId),
  microsoftRemove: (accountId) => ipcRenderer.invoke('auth:microsoft-remove', accountId),
  microsoftLogout: () => ipcRenderer.invoke('auth:microsoft-logout'),
  onLog: (handler) => {
    ipcRenderer.on('launcher:log', (_, line) => handler(line));
  },
  onProgress: (handler) => {
    ipcRenderer.on('launcher:progress', (_, progress) => handler(progress));
  }
});
