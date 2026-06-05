import { app, BrowserWindow, ipcMain, net, protocol, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  clearCallHistory,
  clearServerConfig,
  closeDatabase,
  countMissedCalls,
  initDatabase,
  insertCallHistory,
  listCallHistory,
  loadServerConfig,
  saveServerConfig,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_NAME = process.env.VITE_APP_NAME || 'UCM Softphone';

const DIST_ROOT = path.resolve(path.join(__dirname, '../dist'));

/** Secure origin for packaged UI (avoids file:// + WSS/TLS issues in production). */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

/** @type {BrowserWindow | null} */
let mainWindow = null;

function resolvePreloadPath() {
  const candidates = ['preload.js', 'preload.mjs', 'preload.cjs'];
  for (const name of candidates) {
    const filePath = path.join(__dirname, name);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return path.join(__dirname, 'preload.mjs');
}

/** Window/taskbar icon in dev (packaged .app/.exe icons come from electron-builder). */
function resolveWindowIcon() {
  const buildIconsDir = path.resolve(path.join(__dirname, '../build/icons'));
  const candidates =
    process.platform === 'darwin'
      ? [path.join(buildIconsDir, 'icon.icns'), path.join(buildIconsDir, 'icon.ico')]
      : [path.join(buildIconsDir, 'icon.ico'), path.join(buildIconsDir, 'icon.icns')];

  return candidates.find((filePath) => fs.existsSync(filePath));
}

// Grandstream UCM on LAN often uses self-signed TLS on wss://
app.commandLine.appendSwitch('ignore-certificate-errors', 'true');
app.commandLine.appendSwitch('allow-insecure-localhost', 'true');

/** Real host ICE + no mDNS masking (must run before app.ready; also called before BrowserWindow). */
function appendWebRtcChromiumSwitches() {
  app.commandLine.appendSwitch('force-wrtc-local-ip-fields');
  app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
}

appendWebRtcChromiumSwitches();

// Allow both LAN and public candidates (required for home → cloud UCM media).
app.commandLine.appendSwitch(
  'webrtc-ip-handling-policy',
  'default_public_and_private_interfaces',
);

/**
 * Pick the LAN IPv4 on the same /24 subnet as the UCM (best effort).
 * @param {string} serverIp
 * @returns {string | null}
 */
function pickLocalIpForServer(serverIp) {
  const serverOctets = serverIp.split('.').map((part) => Number.parseInt(part, 10));
  const serverIsV4 =
    serverOctets.length === 4 && serverOctets.every((octet) => !Number.isNaN(octet));

  const candidates = [];

  for (const ifaceRecords of Object.values(os.networkInterfaces())) {
    if (!ifaceRecords) continue;

    for (const addr of ifaceRecords) {
      const family = addr.family === 'IPv4' || addr.family === 4;
      if (!family || addr.internal) continue;

      candidates.push(addr.address);

      if (serverIsV4) {
        const hostOctets = addr.address.split('.').map((part) => Number.parseInt(part, 10));
        if (
          hostOctets[0] === serverOctets[0] &&
          hostOctets[1] === serverOctets[1] &&
          hostOctets[2] === serverOctets[2]
        ) {
          return addr.address;
        }
      }
    }
  }

  return (
    candidates.find((ip) => !ip.startsWith('127.') && !ip.startsWith('169.254.')) ??
    candidates[0] ??
    null
  );
}

ipcMain.handle('network:getLocalIp', (_event, serverIp) => {
  if (!serverIp || typeof serverIp !== 'string') {
    return null;
  }
  return pickLocalIpForServer(serverIp.trim());
});

ipcMain.handle('config:load', () => loadServerConfig());

ipcMain.handle('config:save', (_event, config) => {
  if (!config?.serverIp || !config?.extension) {
    throw new Error('serverIp and extension are required to save config.');
  }
  return saveServerConfig(config);
});

ipcMain.handle('config:clear', () => {
  clearServerConfig();
  return true;
});

ipcMain.handle('callHistory:add', (_event, entry) => insertCallHistory(entry));

ipcMain.handle('callHistory:list', (_event, filter = 'all', limit = 100) =>
  listCallHistory(filter, limit),
);

ipcMain.handle('callHistory:missedCount', () => countMissedCalls());

ipcMain.handle('callHistory:clear', () => {
  clearCallHistory();
  return true;
});

/**
 * Grandstream UCM WSS often uses a self-signed certificate. Chromium blocks wss://
 * unless we accept it explicitly (command-line switches alone are unreliable in
 * packaged builds loading from file:// or app://).
 */
function configureTlsForUcm() {
  session.defaultSession.setCertificateVerifyProc((_request, callback) => {
    callback(0);
  });
}

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let resourcePath = decodeURIComponent(url.pathname);
    if (!resourcePath || resourcePath === '/') {
      resourcePath = '/index.html';
    }

    const filePath = path.resolve(path.join(DIST_ROOT, resourcePath.replace(/^\//, '')));
    if (!filePath.startsWith(`${DIST_ROOT}${path.sep}`) && filePath !== DIST_ROOT) {
      return new Response('Forbidden', { status: 403 });
    }

    return net.fetch(pathToFileURL(filePath).href);
  });
}

function trustCertificateForWindow(win) {
  win.webContents.on('certificate-error', (event, url, _error, _certificate, callback) => {
    if (/^https?:\/\//i.test(url) || /^wss?:\/\//i.test(url)) {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
  });
}

ipcMain.handle('window:focus', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
  return true;
});

function createWindow() {
  const windowIcon = resolveWindowIcon();

  mainWindow = new BrowserWindow({
    width: 380,
    height: 540,
    title: APP_NAME,
    resizable: true,
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: resolvePreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // WebRTC Local IP ပေါ်စေရန် အောက်ပါလိုင်း ထည့်ပေးပါ
      enableBlinkFeatures: 'WebRTC-H264WithOpenH264FFmpeg',
    },
  });

  trustCertificateForWindow(mainWindow);

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadURL('app://local/index.html');
  }

  return mainWindow;
}

app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  if (/^https?:\/\//i.test(url) || /^wss?:\/\//i.test(url)) {
    event.preventDefault();
    callback(true);
    return;
  }
  callback(false);
});

app.whenReady().then(async () => {
  app.setName(APP_NAME);

  try {
    configureTlsForUcm();
    if (!process.env.VITE_DEV_SERVER_URL) {
      registerAppProtocol();
    }

    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      if (permission === 'media' || permission === 'speaker-selection') {
        callback(true);
        return;
      }
      callback(false);
    });

    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
      return permission === 'media' || permission === 'speaker-selection';
    });

    initDatabase(app.getPath('userData'));

    appendWebRtcChromiumSwitches();
    createWindow();
  } catch (error) {
    console.error('[Electron] Failed to initialize app:', error);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  closeDatabase();
});
