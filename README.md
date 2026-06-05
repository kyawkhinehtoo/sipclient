# 📞 Grandstream UCM WebRTC Electron Softphone (Unofficial)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Framework: Vue 3](https://img.shields.io/badge/Framework-Vue%203-4fc08d.svg)](https://vuejs.org/)
[![Platform: Electron](https://img.shields.io/badge/Platform-Electron-4784bc.svg)](https://www.electronjs.org/)
[![Download: Installers](https://img.shields.io/badge/Download-Latest%20Installers-blueviolet.svg?style=flat&logo=github)](../../releases/latest)

A production-ready desktop softphone built with **Vue 3**, **Tailwind CSS**, **Electron**, and **SIP.js 0.21.1**, specifically engineered and optimized for **Grandstream UCM6200/6300 series PBX** operating behind complex server-side double NAT or WAN environments.

> 📥 **Quick Start:** You can **[Download the Latest Windows (.exe) and macOS (.dmg) Installers from the Releases Section](../../releases/latest)** directly to get started.
> 
> ⚠️ **Disclaimer:** This is an **unofficial** community-driven project built for customization and advanced CTI testing. It is not affiliated with, endorsed by, or associated with Grandstream Networks, Inc.

---

## 🔥 Key Technical Bugs Solved

This repository provides production-tested workarounds for notorious WebRTC/SIP implementation issues specific to Grandstream UCM (Asterisk-based) firmware:

* **Grandstream `.invalid` Contact Bug Bypass:** Automatically rewrites the contact host context to `127.0.0.1` while carefully preserving WebRTC ephemeral ports. This prevents the UCM's `rport` and received mechanism from failing when `sip.js` attempts to ship raw `*.invalid` WebRTC domain strings.
* **Telecom Operator Early Media Playback:** Introduces a precise macro-task delayed teardown execution loop (3500 ms) inside `onReject` final states (`404 Not Found`, `486 Busy Here`, `503 Service Unavailable`). This explicitly keeps the `RTCPeerConnection` and media tracks alive long enough to capture and stream in-band carrier telecom audio announcements (e.g., *"The number you have dialed..."*) before session destruction.
* **Attended Transfer (Warm Transfer / Consultation):** Implements a consultative multi-session routing pipeline. Allows agents to seamlessly place the primary customer leg on remote hold, establish a secondary outbound consultation channel to a dynamic team extension, and perform a full bridging handshake via `SIP REFER with Replaces`.
* **Local Busy Tone Fallback Syntax:** Monitors incoming rejection response contexts. If an internal PBX extension triggers a rejection *without* attaching an Audio SDP payload, the app automatically generates and synthesizes a native call progression tone (*"Tu... Tu... Tu..."*) locally via a custom tone synthesis engine.

> **Note:** Additional hardening includes an embedded **sip.js native patch** resolving deep-level `REGISTER 200 OK` Contact matching failures caused by UCM runtime port/host rewriting maneuvers, alongside **STUN-first fast candidate selection** for optimized WAN WebRTC media mapping.

---

## 🌟 Core Features

* **Secure Authentication Engine:** Extension login featuring optional session persistence powered by Electron's native OS-level hardware encryption layer (`safeStorage`).
* **Full Call Control Layout:** Native Support for Inbound/Outbound standard streams, digital microphone toggling (Mute), and network line hold states.
* **Enterprise CTI UX Widget:** Contextual In-Call layout displaying active call timers, active mute alerts, and an instant **One-Click Speed Dial Attended Transfer** panel for designated call center queues.
* **Local Storage Engine:** Persisted call history data sheets, missed call notification queues, and quick-transfer team address configurations operating entirely client-side via a local embedded **SQLite** daemon.
* **Universal Installers:** Fully production-packaged setups executable on enterprise workstations natively through cross-platform `.dmg` (macOS) and `.exe` (Windows) distributions.

---

## ⚙️ Requirements

* **Node.js** Version 20.x or higher
* **npm** Version 10.x or higher

---

## 🚀 Getting Started

### 1. Installation & Environment Configuration
Clone this repository to your workstation environment, provision your hardware branding targets, and configure your networking endpoints:

```bash
# Copy the environment template
cp .env.example .env

# Open and customize your enterprise specifications
# Set VITE_APP_NAME, VITE_UCM_HOST, and VITE_UCM_WSS_PORT
```

Install your required dependencies. A built-in `postinstall` script hooks natively to automatically inject our local UCM core patch:

```bash
npm install
```

### 2. Development Lifecycle
To launch the compilation engine with hot module replacement (HMR) and activate your local development environment debugger shell:

```bash
npm run dev
```

### 3. Compiling Production Binaries
To build clean, ready-to-deploy client installers, execute the respective platform wrapper scripts. *Ensure your target `.env` parameters are present during execution as variables are hard-baked into production bundles:*

```bash
npm run dist:mac    # Compiles macOS native .dmg & universal zip bundles
npm run dist:win    # Compiles Windows standard NSIS .exe setup bundles
npm run dist:all    # Compiles packages for both operating systems simultaneously
```

All final compiled distribution builds are automatically written to the root `/release` folder.

---

## 📂 Project Architecture

```text
├── electron/          # Main architecture scripts, preload declarations, and safeStorage bindings
├── patches/           # Version-locked local automated patches (resolving sip.js registration matching)
├── src/               # Vue 3 reactive layout layers, Tailwind design templates, and global SIP state service
│   ├── components/    # Reusable user interface components (Dialpad, In-call controls, Settings)
│   ├── services/      # Core singleton softphone orchestration (`sipService.js`)
│   └── store/         # Call logs, SQLite communication handlers, and state management
├── build/icons/       # Native source file application graphics assets (icon.ico, icon.icns)
└── .env.example       # Distribution reference configuration model
```

---

## 🔒 Security Parameters

* **Credential Security:** When the "Remember settings" feature is flagged, extension configuration secrets are immediately encrypted at rest using Chromium's specialized cryptographical hooks before hitting the localized SQLite storage volume.
* **Network Transport Layer:** Packed production builds are configured with strict TLS exception bypass flags specifically for local UCM address ranges, allowing seamless handling of corporate networks employing self-signed SSL/TLS certificates over secure WebSockets (`wss://`).
* **Data Integrity Guardrail:** Do **NOT** check in or commit your `.env` configuration mapping targets to public version control systems.
