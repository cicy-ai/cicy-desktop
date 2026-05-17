const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("backends", {
  list:   ()        => ipcRenderer.invoke("backends:list"),
  add:    (input)   => ipcRenderer.invoke("backends:add", input),
  remove: (id)      => ipcRenderer.invoke("backends:remove", id),
  probe:  (input)   => ipcRenderer.invoke("backends:probe", input),
  open:   (id)      => ipcRenderer.invoke("backends:open", id),
});
