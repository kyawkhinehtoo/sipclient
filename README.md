# UCM Desktop Softphone

Electron + Vue 3 WebRTC softphone for Grandstream UCM6200 (SIP over WSS).

## Features

- Extension login with optional saved credentials
- Outbound / inbound calls, mute, hold
- Attended (consultative) transfer with configurable transfer teams
- Call history and missed-call log (SQLite, local to each machine)
- macOS and Windows installers via electron-builder

## Requirements

- Node.js 20+
- npm

## Setup

```bash
cp .env.example .env
# Edit .env — set VITE_APP_NAME, VITE_UCM_HOST, VITE_UCM_WSS_PORT
npm install
```

`postinstall` applies `patches/sip.js+0.21.2.patch` (Grandstream UCM contact handling).

## Development

```bash
npm run dev
```

Runs Vite + Electron with hot reload.

## Production builds

```bash
npm run dist:mac    # DMG + zip (arm64 on Apple Silicon)
npm run dist:win    # NSIS + portable (x64)
npm run dist:all    # both
```

Artifacts are written to `release/`. Ensure `.env` is present before building so UCM host/branding are baked into the bundle.

## Project layout

| Path | Purpose |
|------|---------|
| `src/` | Vue UI and SIP services |
| `electron/` | Main process, SQLite, preload |
| `build/icons/` | App icons (`icon.icns`, `icon.ico`) |
| `patches/` | sip.js patch for UCM registration |

## Security notes

- Do **not** commit `.env` (contains PBX host and branding).
- Passwords are stored encrypted via Electron `safeStorage` when “Remember settings” is enabled.
