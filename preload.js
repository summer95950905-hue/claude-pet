const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpet', {
  onEvent: (cb) => ipcRenderer.on('cc-event', (_, data) => cb(data)),
  onTick: (cb) => ipcRenderer.on('cc-tick', (_, data) => cb(data)),
  onDrag: (cb) => ipcRenderer.on('cc-drag', (_, data) => cb(data)),
  onDragEnd: (cb) => ipcRenderer.on('cc-drag-end', () => cb()),
  onZoom: (cb) => ipcRenderer.on('cc-zoom', (_, data) => cb(data)),
  getPort: () => ipcRenderer.invoke('get-port'),
  moveBy: (dx, dy) => ipcRenderer.send('win-move-delta', dx, dy),
  dragStart: () => ipcRenderer.send('win-drag-start'),
  dragEnd: () => ipcRenderer.send('win-drag-end'),
  rally: () => ipcRenderer.send('rally'),
  petClick: () => ipcRenderer.send('pet-click'),
  showMenu: () => ipcRenderer.send('show-context-menu'),
});
