import { loadEnv } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = loadEnv('production', __dirname, '');

const productName = env.VITE_APP_NAME || 'UCM Softphone';

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'com.ucm.desktop.softphone',
  productName,
  copyright: 'Copyright © UCM Desktop Client',
  directories: {
    output: 'release',
    buildResources: 'build',
  },
  files: ['dist/**/*', 'dist-electron/**/*', 'package.json'],
  asarUnpack: ['**/node_modules/better-sqlite3/**'],
  npmRebuild: true,
  mac: {
    icon: 'icons/icon.icns',
    category: 'public.app-category.business',
    target: [
      { target: 'dmg' },
      { target: 'zip' },
    ],
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  win: {
    icon: 'icons/icon.ico',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    shortcutName: productName,
    installerIcon: 'icons/icon.ico',
    uninstallerIcon: 'icons/icon.ico',
    installerHeaderIcon: 'icons/icon.ico',
  },
};
