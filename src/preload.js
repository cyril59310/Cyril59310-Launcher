const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcLauncher', {
  start: (payload) => ipcRenderer.invoke('launcher:start', payload),
  getAppVersion: () => ipcRenderer.invoke('launcher:app-version'),
  getVersions: (options) => ipcRenderer.invoke('launcher:versions', options),
  openGameFolder: (targetPath) => ipcRenderer.invoke('launcher:open-game-folder', targetPath),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  createProfile: (name) => ipcRenderer.invoke('profiles:create', name),
  updateProfile: (payload) => ipcRenderer.invoke('profiles:update', payload),
  deleteProfile: (payload) => ipcRenderer.invoke('profiles:delete', payload),
  chooseProfileFolder: (initialPath) => ipcRenderer.invoke('profiles:choose-folder', initialPath),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdateNow: () => ipcRenderer.invoke('updater:install'),
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
  },
  onUpdate: (handler) => {
    ipcRenderer.on('launcher:update', (_, event) => handler(event));
  }
});
