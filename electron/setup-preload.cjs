const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agentInboxSetup', {
  available() {
    return ipcRenderer.invoke('agent-inbox:install-available')
  },
  install(target) {
    return ipcRenderer.invoke('agent-inbox:install', target)
  },
})
