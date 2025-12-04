// main/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  toggleDashboard: () => ipcRenderer.send('toggle-dashboard'),
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('set-ignore-mouse-events', ignore),

  tasks: {
    list:   () => ipcRenderer.invoke('tasks:list'),
    add:    (task)  => ipcRenderer.invoke('tasks:add', task),
    update: (patch) => ipcRenderer.invoke('tasks:update', patch),
    remove: (id)    => ipcRenderer.invoke('tasks:delete', id),
    reorder:(ids)   => ipcRenderer.invoke('tasks:reorder', ids)
  },

  timer: {
    listSessions: ()    => ipcRenderer.invoke('timer:sessions:list'),
    addSession:   (obj) => ipcRenderer.invoke('timer:sessions:add', obj)
  },

  ai: {
  quiz:      (topic, difficulty, numQuestions) =>
    ipcRenderer.invoke('ai:quiz', { topic, difficulty, numQuestions }),
  doubt:     (question, lastAnswer) =>
    ipcRenderer.invoke('ai:doubt', { question, lastAnswer }),
  summarize: (mode) =>
    ipcRenderer.invoke('ai:summarize', { mode }),
  ingest: () =>
    ipcRenderer.invoke('ai:ingest'),
  },

  gcalConnect: () => ipcRenderer.invoke('gcal:connect'),
  gcalAddEvent: (eventResource) => ipcRenderer.invoke('gcal:addEvent', eventResource)



});

