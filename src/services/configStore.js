/**
 * Renderer-side access to persisted server config (SQLite in Electron main process).
 */

/**
 * @typedef {Object} ServerConfig
 * @property {string} serverIp
 * @property {string} extension
 * @property {string} password
 * @property {string} [localIp]
 * @property {number} [wsPort]
 * @property {boolean} [rememberConfig]
 * @property {boolean} [autoLogin]
 * @property {boolean} [preferLanIp]
 * @property {Array<{ id?: string, name: string, extension: string, color?: string }>} [transferTeams]
 */

function getApi() {
  if (typeof window === 'undefined' || !window.electronAPI?.config) {
    return null;
  }
  return window.electronAPI.config;
}

export const configStore = {
  /**
   * @returns {Promise<ServerConfig | null>}
   */
  async load() {
    const api = getApi();
    if (!api) {
      return null;
    }
    return api.load();
  },

  /**
   * @param {ServerConfig} config
   * @returns {Promise<ServerConfig | null>}
   */
  async save(config) {
    const api = getApi();
    if (!api) {
      return null;
    }
    return api.save(config);
  },

  async clear() {
    const api = getApi();
    if (!api) {
      return;
    }
    await api.clear();
  },

  isAvailable() {
    return getApi() !== null;
  },
};

export default configStore;
