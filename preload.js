const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getBoard: () => ipcRenderer.invoke('get-board'),
  saveBoard: (board) => ipcRenderer.invoke('save-board', board),
  selectImage: () => ipcRenderer.invoke('select-image'),
  importImagePath: (p) => ipcRenderer.invoke('import-image-path', p),
  getFilePath: (file) => { try { return webUtils.getPathForFile(file); } catch { return file?.path || null; } },
  ocrImage: (url) => ipcRenderer.invoke('ocr-image', url),
  getMode: () => ipcRenderer.invoke('get-mode'),
  setMode: (mode) => ipcRenderer.invoke('set-mode', mode),
  moveBy: (dx, dy) => ipcRenderer.send('move-by', dx, dy),
  resizeTo: (w, h) => ipcRenderer.send('resize-to', w, h),
  hideWindow: () => ipcRenderer.send('hide-window'),
  quitApp: () => ipcRenderer.send('quit-app'),
  onModeChanged: (cb) => ipcRenderer.on('mode-changed', (_, mode) => cb(mode)),
});
