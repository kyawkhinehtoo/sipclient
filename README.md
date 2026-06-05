# Grandstream UCM WebRTC Electron Softphone

A production-ready desktop softphone built with **Vue 3**, **Tailwind CSS**, **Electron**, and **SIP.js 0.21.1**, specifically optimized for **Grandstream UCM6200/6300 series PBX** behind server-side double NAT.

## Key technical solved bugs

- **Grandstream `.invalid` Contact bug bypass** — Dynamic host rewriting to `127.0.0.1` while preserving WebRTC ephemeral ports, so UCM `rport` mapping does not fail when sip.js would otherwise ship `*.invalid` contacts.
- **Telecom operator early media playback** — Delayed teardown injection (3500 ms) on `onReject` states (404, 486, 503) to capture and play in-band carrier audio announcements before the peer connection is disposed.
- **Attended transfer (warm transfer)** — Consultative session management: hold the customer, preview the target, then bridge legs with SIP REFER w/Replaces.
- **Local busy tone fallback** — Synthesized busy tone when internal extensions reject without SDP (no remote announcement to play).

Additional hardening includes a **sip.js patch** for REGISTER 200 OK Contact matching when UCM rewrites host/port, **STUN-first ICE** and SDP munging for WAN media paths, and **TLS trust** for self-signed UCM WSS in packaged Electron builds.

## Features

- Extension login with optional saved credentials and auto-login
- Outbound / inbound calls, mute, hold
- Quick-transfer teams (settings) and attended transfer UI
- Call history and missed-call log (SQLite, per machine)
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

`postinstall` applies `patches/sip.js+0.21.2.patch` (Grandstream UCM REGISTER Contact handling).

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

Artifacts are written to `release/`. Run builds with `.env` present so UCM host and branding are baked into the bundle.

## Project layout

| Path | Purpose |
|------|---------|
| `src/` | Vue UI, SIP service, call history |
| `electron/` | Main process, SQLite, preload, TLS/protocol |
| `build/icons/` | App icons (`icon.icns`, `icon.ico`) |
| `patches/` | sip.js patch for UCM registration |

## Security notes

- Do **not** commit `.env` (PBX host and branding).
- Passwords are stored with Electron `safeStorage` when “Remember settings” is enabled.
