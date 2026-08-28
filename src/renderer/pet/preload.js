const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pandaAPI", {
  onSetEmotion: (callback) => {
    ipcRenderer.on("pet:set-emotion", (_event, payload) => callback(payload));
  },
  reactClick: () => ipcRenderer.send("pet:clicked"),
  openContextMenu: () => ipcRenderer.send("pet:context-menu"),
  openNotepad: () => ipcRenderer.send("pet:open-notepad"),
});
