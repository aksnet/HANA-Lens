# HANA-Lens

A native desktop diagnostic tool for SAP HANA support engineers. Analyzes Full System Info Dumps (FSID) and HANA Support Info (HSI) packages — including topology, configuration, trace files, runtime dumps, and network tests — without requiring a running HANA system or internet access.

Built with [Tauri](https://tauri.app) (Rust + WebView2/WebKit). Runs on Windows and macOS (Apple Silicon).

---

## Features

- **Topology** — visual overview of scale-out layouts, host roles, replication tiers, SAP Note checks
- **Version History** — installed HANA revisions, patch level timeline
- **Configuration** — side-by-side `.ini` viewer with default comparison and deviation highlighting
- **Trace Explorer** — browse and read `.trc` log files directly, large files loaded in chunks
- **Runtime Dumps** — parse and display `.rtedump.trc` crash/dump files
- **Nameserver History** — failover and role-change timeline
- **System Availability** — uptime view from availability log
- **Telemetry Data** — key system metrics
- **Network Test (NETTEST)** — renders `Network_Test.log` output; one-click "Prepare SAP Joule Work Desktop" button to generate a ready-to-paste AI analysis prompt

---

## Download

Go to the [Releases](../../releases) page and download the latest version.

### Windows

| File | Description |
|---|---|
| `HANA-Lens_YYYY_MM_DD_vv_x64-portable.zip` | **Portable** — extract and run, no installation needed |
| `HANA-Lens_YYYY_MM_DD_vv_x64-setup.exe` | Installer (NSIS) |
| `HANA-Lens_YYYY_MM_DD_vv_x64.msi` | MSI installer |

**Portable usage:** Extract the ZIP, double-click `HANA-Lens.exe`. No installation or additional software required. WebView2 is pre-installed on all Windows 11 systems (ships with Microsoft Edge).

### macOS (Apple Silicon)

| File | Description |
|---|---|
| `HANA-Lens_YYYY_MM_DD_vv_aarch64.dmg` | macOS disk image (Apple Silicon / M1/M2/M3) |

> **Intel Mac (x86_64) is not currently supported.** The build targets Apple Silicon only.

---

## macOS Installation & First Launch Guide

When downloading HANA-Lens directly from GitHub on macOS, Apple's Gatekeeper security feature will block the application from launching because it is not notarized by an Apple Developer account.

### The Error You Will See

After opening the DMG and moving the app to Applications, double-clicking it will show:

> **"HANA-Lens.app" is damaged and can't be opened. You should move it to the Trash.**

The app is not damaged. This is standard macOS behavior for unnotarized apps downloaded from the internet.

### How to Fix It

**Step 1 — Move the App**

Drag `HANA-Lens.app` from your Downloads folder (or the DMG) into your `/Applications` folder.

**Step 2 — Open Terminal**

Press `Cmd + Space`, type `Terminal`, press Enter.

**Step 3 — Run This Command**

```bash
sudo xattr -r -d com.apple.quarantine /Applications/HANA-Lens.app
```

**Step 4 — Enter Your Password**

Terminal will ask for your Mac administrator password. Type it and press Enter. No characters will appear while typing — this is normal.

**Step 5 — Launch the App**

Open `/Applications` and double-click `HANA-Lens.app`. It will now launch without any error.

---

## Requirements

| Platform | Requirement |
|---|---|
| Windows | Windows 10/11 x64, WebView2 (included with Edge) |
| macOS | macOS 12+, Apple Silicon (M1/M2/M3) |
