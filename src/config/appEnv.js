/** App and UCM settings from `.env` (VITE_* variables). */

export const appName = import.meta.env.VITE_APP_NAME || 'UCM Softphone';

export const appTagline = import.meta.env.VITE_APP_TAGLINE || '';

/** UCM hostname or IP — when set, agents do not enter it on the login screen. */
export const ucmHost = String(import.meta.env.VITE_UCM_HOST ?? '').trim();

export const isUcmHostFromEnv = Boolean(ucmHost);

const envWsPort = String(import.meta.env.VITE_UCM_WSS_PORT ?? '').trim();

/** WSS port; defaults to 8089. */
export const ucmWsPort = envWsPort ? Number(envWsPort) || 8089 : 8089;

export const isUcmWsPortFromEnv = Boolean(envWsPort);
