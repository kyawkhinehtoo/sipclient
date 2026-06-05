import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
const externalDeps = Object.keys(pkg.dependencies ?? {})

/** Keep native / Node deps out of the Electron main bundle (Vite 8 uses rolldownOptions). */
function electronMainExternal(id) {
  if (id === 'electron' || id === 'better-sqlite3') {
    return true
  }
  if (id.startsWith('node:')) {
    return true
  }
  if (externalDeps.includes(id)) {
    return true
  }
  return false
}

const electronMainBuild = {
  rollupOptions: { external: electronMainExternal },
  rolldownOptions: { external: electronMainExternal },
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  const appName = env.VITE_APP_NAME || 'UCM Softphone'
  const appTagline = env.VITE_APP_TAGLINE || ''
  const ucmHost = env.VITE_UCM_HOST || ''
  const ucmWsPort = env.VITE_UCM_WSS_PORT || ''

  const envDefine = {
    'import.meta.env.VITE_APP_NAME': JSON.stringify(appName),
    'import.meta.env.VITE_APP_TAGLINE': JSON.stringify(appTagline),
    'import.meta.env.VITE_UCM_HOST': JSON.stringify(ucmHost),
    'import.meta.env.VITE_UCM_WSS_PORT': JSON.stringify(ucmWsPort),
    'process.env.VITE_APP_NAME': JSON.stringify(appName),
    'process.env.VITE_APP_TAGLINE': JSON.stringify(appTagline),
    'process.env.VITE_UCM_HOST': JSON.stringify(ucmHost),
    'process.env.VITE_UCM_WSS_PORT': JSON.stringify(ucmWsPort),
  }

  return {
    envPrefix: 'VITE_',
    define: envDefine,
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    plugins: [
      vue(),
      tailwindcss(),
      electron({
        main: {
          entry: 'electron/main.js',
          vite: {
            define: envDefine,
            build: electronMainBuild,
          },
        },
        preload: {
          input: 'electron/preload.js',
        },
      }),
    ],
  }
})
