import configStore from './configStore.js';

const LOCAL_STORAGE_KEY = 'ucm-transfer-teams';

/** @typedef {{ id: string, name: string, extension: string, color: string }} TransferTeam */

export const TEAM_COLORS = [
  'bg-blue-600',
  'bg-amber-600',
  'bg-purple-600',
  'bg-emerald-600',
  'bg-rose-600',
  'bg-cyan-600',
];

function newTeamId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `team-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * @param {unknown} raw
 * @returns {TransferTeam[]}
 */
export function normalizeTransferTeams(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  const teams = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    const name = String(item?.name ?? '').trim();
    const extension = String(item?.extension ?? '').trim();
    if (!name || !extension) {
      continue;
    }
    teams.push({
      id: String(item?.id ?? `${extension}-${i}`),
      name,
      extension,
      color: TEAM_COLORS.includes(item?.color) ? item.color : TEAM_COLORS[teams.length % TEAM_COLORS.length],
    });
  }

  return teams;
}

/**
 * @param {string} name
 * @param {string} extension
 * @param {number} existingCount
 * @returns {TransferTeam}
 */
export function buildTransferTeam(name, extension, existingCount) {
  return {
    id: newTeamId(),
    name: name.trim(),
    extension: extension.trim(),
    color: TEAM_COLORS[existingCount % TEAM_COLORS.length],
  };
}

function readLocalTeams() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return normalizeTransferTeams(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeLocalTeams(teams) {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(teams));
  } catch {
    // ignore quota / private mode
  }
}

/**
 * @returns {Promise<TransferTeam[]>}
 */
export async function loadTransferTeams() {
  const config = await configStore.load();
  if (config && Array.isArray(config.transferTeams)) {
    return normalizeTransferTeams(config.transferTeams);
  }

  const local = readLocalTeams();
  if (local !== null) {
    return local;
  }

  return [];
}

/**
 * Persist teams alongside server config when available.
 * @param {TransferTeam[]} teams
 * @param {import('./configStore.js').ServerConfig | null} [serverConfig]
 */
export async function saveTransferTeams(teams, serverConfig = null) {
  const normalized = normalizeTransferTeams(teams);
  writeLocalTeams(normalized);

  if (!configStore.isAvailable() || !serverConfig?.serverIp || !serverConfig?.extension) {
    return normalized;
  }

  await configStore.save({
    ...serverConfig,
    transferTeams: normalized,
  });

  return normalized;
}

export default {
  TEAM_COLORS,
  normalizeTransferTeams,
  buildTransferTeam,
  loadTransferTeams,
  saveTransferTeams,
};
