/**
 * Renderer access to persisted call history (SQLite in Electron main process).
 */

/**
 * @typedef {Object} CallHistoryEntry
 * @property {number} id
 * @property {'inbound' | 'outbound'} direction
 * @property {string} remoteParty
 * @property {'answered' | 'missed' | 'outbound_no_answer' | 'cancelled' | 'failed'} outcome
 * @property {number} durationSeconds
 * @property {number | null} [statusCode]
 * @property {string} [statusLabel]
 * @property {string} startedAt
 * @property {string} endedAt
 */

/**
 * @typedef {Object} CallHistoryInput
 * @property {'inbound' | 'outbound'} direction
 * @property {string} remoteParty
 * @property {'answered' | 'missed' | 'outbound_no_answer' | 'cancelled' | 'failed'} outcome
 * @property {number} [durationSeconds]
 * @property {number} [statusCode]
 * @property {string} [statusLabel]
 * @property {string} [startedAt]
 * @property {string} [endedAt]
 */

function getApi() {
  if (typeof window === 'undefined' || !window.electronAPI?.callHistory) {
    return null;
  }
  return window.electronAPI.callHistory;
}

export const callHistoryStore = {
  isAvailable() {
    return getApi() !== null;
  },

  /**
   * @param {CallHistoryInput} entry
   * @returns {Promise<CallHistoryEntry | null>}
   */
  async add(entry) {
    const api = getApi();
    if (!api) {
      return null;
    }
    return api.add(entry);
  },

  /**
   * @param {'all' | 'missed'} [filter]
   * @param {number} [limit]
   * @returns {Promise<CallHistoryEntry[]>}
   */
  async list(filter = 'all', limit = 100) {
    const api = getApi();
    if (!api) {
      return [];
    }
    return api.list(filter, limit);
  },

  /**
   * @returns {Promise<number>}
   */
  async missedCount() {
    const api = getApi();
    if (!api) {
      return 0;
    }
    return api.missedCount();
  },

  async clear() {
    const api = getApi();
    if (!api) {
      return;
    }
    await api.clear();
  },
};

export default callHistoryStore;
