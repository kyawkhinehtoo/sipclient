import { contextBridge, ipcRenderer } from 'electron';

const ALLOWED_INVOKE_CHANNELS = new Set([
  'app:getVersion',
  'network:getLocalIp',
  'config:load',
  'config:save',
  'config:clear',
  'callHistory:add',
  'callHistory:list',
  'callHistory:missedCount',
  'callHistory:clear',
  'window:focus',
]);

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },

  /**
   * Whitelisted IPC invoke bridge for future OS integrations
   * (notifications, shell.openExternal, window controls, etc.).
   */
  invoke(channel, ...args) {
    if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  /** Resolve this machine's LAN IP (same subnet as UCM when possible). */
  getLocalIp(serverIp) {
    return ipcRenderer.invoke('network:getLocalIp', serverIp);
  },

  /** Bring the softphone window to the front (incoming call). */
  focusWindow() {
    return ipcRenderer.invoke('window:focus');
  },

  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (config) => ipcRenderer.invoke('config:save', config),
    clear: () => ipcRenderer.invoke('config:clear'),
  },

  callHistory: {
    add: (entry) => ipcRenderer.invoke('callHistory:add', entry),
    list: (filter, limit) => ipcRenderer.invoke('callHistory:list', filter, limit),
    missedCount: () => ipcRenderer.invoke('callHistory:missedCount'),
    clear: () => ipcRenderer.invoke('callHistory:clear'),
  },

  on(channel, listener) {
    const allowed = new Set(['app:update-available']);
    if (!allowed.has(channel)) {
      throw new Error(`IPC channel not allowed: ${channel}`);
    }
    const subscription = (_event, ...payload) => listener(...payload);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  },
});
