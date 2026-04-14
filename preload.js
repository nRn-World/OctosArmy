const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    pickFolder: () => ipcRenderer.invoke('pick-folder'),
    getRoots: () => ipcRenderer.invoke('get-roots'),
    setRoots: (roots) => ipcRenderer.invoke('set-roots', roots),
    getWorkspace: () => ipcRenderer.invoke('get-workspace'),

    // Auto-updater
    restartAndInstall: () => ipcRenderer.send('restart-and-install'),
    onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, info) => cb(info)),
    onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_e, info) => cb(info)),
    onUpdateError: (cb) => ipcRenderer.on('update-error', (_e, msg) => cb(msg)),
});
