const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notesAPI", {
  load: () => ipcRenderer.invoke("notes:load"),
  save: (text) => ipcRenderer.send("notes:save", text),
  close: () => ipcRenderer.send("notepad:close"),
});
