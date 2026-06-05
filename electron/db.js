import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { safeStorage } from 'electron';

const require = createRequire(import.meta.url);

function openDatabase(dbPath) {
  const Database = require('better-sqlite3');
  return new Database(dbPath);
}

/** @type {import('better-sqlite3').Database | null} */
let db = null;

const CONFIG_ROW_ID = 1;

function encryptSecret(plainText) {
  if (!plainText) {
    return '';
  }
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plainText).toString('base64');
  }
  return Buffer.from(plainText, 'utf8').toString('base64');
}

function decryptSecret(cipherText) {
  if (!cipherText) {
    return '';
  }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(cipherText, 'base64'));
    }
    return Buffer.from(cipherText, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * @param {string} userDataPath
 */
export function initDatabase(userDataPath) {
  if (db) {
    return db;
  }

  const dbDir = path.join(userDataPath, 'data');
  fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, 'ucm-softphone.db');
  db = openDatabase(dbPath);

  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      server_ip TEXT NOT NULL,
      extension TEXT NOT NULL,
      password_encrypted TEXT NOT NULL DEFAULT '',
      local_ip TEXT,
      ws_port INTEGER NOT NULL DEFAULT 8089,
      remember_config INTEGER NOT NULL DEFAULT 1,
      auto_login INTEGER NOT NULL DEFAULT 0,
      transfer_teams_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const columns = db.prepare('PRAGMA table_info(server_config)').all();
  if (!columns.some((col) => col.name === 'transfer_teams_json')) {
    db.exec(`ALTER TABLE server_config ADD COLUMN transfer_teams_json TEXT NOT NULL DEFAULT '[]'`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS call_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      remote_party TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('answered', 'missed', 'outbound_no_answer', 'cancelled', 'failed')),
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER,
      status_label TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_call_history_started ON call_history (started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_call_history_outcome ON call_history (outcome);
  `);

  return db;
}

/**
 * @param {string | null | undefined} json
 * @returns {Array<{ id?: string, name: string, extension: string, color?: string }> | undefined}
 */
function parseTransferTeamsJson(json) {
  if (!json) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * @returns {ServerConfigRecord | null}
 */
export function loadServerConfig() {
  if (!db) {
    return null;
  }

  const row = db
    .prepare(
      `SELECT server_ip, extension, password_encrypted, local_ip, ws_port, remember_config, auto_login, transfer_teams_json
       FROM server_config WHERE id = ?`,
    )
    .get(CONFIG_ROW_ID);

  if (!row) {
    return null;
  }

  const password = decryptSecret(row.password_encrypted);
  if (row.password_encrypted && !password) {
    console.warn(
      '[DB] Saved password could not be decrypted. User must re-enter password on login.',
    );
  }

  return {
    serverIp: row.server_ip,
    extension: row.extension,
    password,
    localIp: row.local_ip ?? '',
    wsPort: row.ws_port ?? 8089,
    rememberConfig: Boolean(row.remember_config),
    autoLogin: Boolean(row.auto_login),
    transferTeams: parseTransferTeamsJson(row.transfer_teams_json),
  };
}

/**
 * @param {{
 *   serverIp: string,
 *   extension: string,
 *   password?: string,
 *   localIp?: string,
 *   wsPort?: number,
 *   rememberConfig?: boolean,
 *   autoLogin?: boolean,
 *   transferTeams?: Array<{ id?: string, name: string, extension: string, color?: string }>,
 * }} config
 */
export function saveServerConfig(config) {
  if (!db) {
    throw new Error('Database is not initialized.');
  }

  const existing = db
    .prepare('SELECT password_encrypted FROM server_config WHERE id = ?')
    .get(CONFIG_ROW_ID);

  let passwordEncrypted = existing?.password_encrypted ?? '';
  if (config.password !== undefined && config.password !== '') {
    passwordEncrypted = encryptSecret(config.password);
  }

  const transferTeamsJson = JSON.stringify(
    Array.isArray(config.transferTeams) ? config.transferTeams : [],
  );

  const stmt = db.prepare(`
    INSERT INTO server_config (
      id, server_ip, extension, password_encrypted, local_ip, ws_port, remember_config, auto_login, transfer_teams_json, updated_at
    ) VALUES (
      @id, @server_ip, @extension, @password_encrypted, @local_ip, @ws_port, @remember_config, @auto_login, @transfer_teams_json, datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      server_ip = excluded.server_ip,
      extension = excluded.extension,
      password_encrypted = excluded.password_encrypted,
      local_ip = excluded.local_ip,
      ws_port = excluded.ws_port,
      remember_config = excluded.remember_config,
      auto_login = excluded.auto_login,
      transfer_teams_json = excluded.transfer_teams_json,
      updated_at = excluded.updated_at
  `);

  stmt.run({
    id: CONFIG_ROW_ID,
    server_ip: config.serverIp.trim(),
    extension: config.extension.trim(),
    password_encrypted: passwordEncrypted,
    local_ip: config.localIp?.trim() || null,
    ws_port: config.wsPort ?? 8089,
    remember_config: config.rememberConfig === false ? 0 : 1,
    auto_login: config.autoLogin ? 1 : 0,
    transfer_teams_json: transferTeamsJson,
  });

  return loadServerConfig();
}

export function clearServerConfig() {
  if (!db) {
    return;
  }
  db.prepare('DELETE FROM server_config WHERE id = ?').run(CONFIG_ROW_ID);
}

/**
 * @param {{
 *   direction: 'inbound' | 'outbound',
 *   remoteParty: string,
 *   outcome: 'answered' | 'missed' | 'outbound_no_answer' | 'cancelled' | 'failed',
 *   durationSeconds?: number,
 *   statusCode?: number,
 *   statusLabel?: string,
 *   startedAt?: string,
 *   endedAt?: string,
 * }} entry
 * @returns {CallHistoryRecord}
 */
export function insertCallHistory(entry) {
  if (!db) {
    throw new Error('Database is not initialized.');
  }

  const remoteParty = String(entry.remoteParty ?? '').trim() || 'Unknown';
  const startedAt = entry.startedAt ?? new Date().toISOString();
  const endedAt = entry.endedAt ?? new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO call_history (
        direction, remote_party, outcome, duration_seconds, status_code, status_label, started_at, ended_at
      ) VALUES (
        @direction, @remote_party, @outcome, @duration_seconds, @status_code, @status_label, @started_at, @ended_at
      )`,
    )
    .run({
      direction: entry.direction,
      remote_party: remoteParty,
      outcome: entry.outcome,
      duration_seconds: Math.max(0, Number(entry.durationSeconds) || 0),
      status_code: entry.statusCode ?? null,
      status_label: entry.statusLabel?.trim() || null,
      started_at: startedAt,
      ended_at: endedAt,
    });

  return getCallHistoryById(Number(result.lastInsertRowid));
}

/**
 * @param {number} id
 * @returns {CallHistoryRecord}
 */
function getCallHistoryById(id) {
  const row = db
    .prepare(
      `SELECT id, direction, remote_party, outcome, duration_seconds, status_code, status_label, started_at, ended_at
       FROM call_history WHERE id = ?`,
    )
    .get(id);

  if (!row) {
    throw new Error(`Call history row ${id} not found.`);
  }

  return mapCallHistoryRow(row);
}

/**
 * @param {import('better-sqlite3').Statement} row
 */
function mapCallHistoryRow(row) {
  return {
    id: row.id,
    direction: row.direction,
    remoteParty: row.remote_party,
    outcome: row.outcome,
    durationSeconds: row.duration_seconds ?? 0,
    statusCode: row.status_code ?? undefined,
    statusLabel: row.status_label ?? '',
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/**
 * @param {'all' | 'missed'} [filter]
 * @param {number} [limit]
 * @returns {CallHistoryRecord[]}
 */
export function listCallHistory(filter = 'all', limit = 100) {
  if (!db) {
    return [];
  }

  const maxRows = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const whereClause = filter === 'missed' ? `WHERE outcome = 'missed'` : '';

  const rows = db
    .prepare(
      `SELECT id, direction, remote_party, outcome, duration_seconds, status_code, status_label, started_at, ended_at
       FROM call_history
       ${whereClause}
       ORDER BY datetime(started_at) DESC
       LIMIT ?`,
    )
    .all(maxRows);

  return rows.map(mapCallHistoryRow);
}

/**
 * @returns {number}
 */
export function countMissedCalls() {
  if (!db) {
    return 0;
  }

  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM call_history WHERE outcome = 'missed'`)
    .get();

  return Number(row?.total) || 0;
}

export function clearCallHistory() {
  if (!db) {
    return;
  }
  db.prepare('DELETE FROM call_history').run();
}

/**
 * @typedef {Object} CallHistoryRecord
 * @property {number} id
 * @property {'inbound' | 'outbound'} direction
 * @property {string} remoteParty
 * @property {'answered' | 'missed' | 'outbound_no_answer' | 'cancelled' | 'failed'} outcome
 * @property {number} durationSeconds
 * @property {number | undefined} [statusCode]
 * @property {string} statusLabel
 * @property {string} startedAt
 * @property {string} endedAt
 */

/**
 * @typedef {Object} ServerConfigRecord
 * @property {string} serverIp
 * @property {string} extension
 * @property {string} password
 * @property {string} localIp
 * @property {number} wsPort
 * @property {boolean} rememberConfig
 * @property {boolean} autoLogin
 * @property {Array<{ id?: string, name: string, extension: string, color?: string }> | undefined} [transferTeams]
 */
