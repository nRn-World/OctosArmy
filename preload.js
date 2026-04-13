const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    pickFolder: () => ipcRenderer.invoke('pick-folder'),
    getRoots: () => ipcRenderer.invoke('get-roots'),
    setRoots: (roots) => ipcRenderer.invoke('set-roots', roots),
    getWorkspace: () => ipcRenderer.invoke('get-workspace'),
});
