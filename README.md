# HANA-Lens

## What is it?

HANA-Lens is a standalone Java desktop tool for analyzing SAP HANA support packages. It runs a local HTTP server and opens automatically in the browser, providing structured navigation and analysis of topology, configuration, version history, availability data, runtime dumps, and trace files — no installation, no external dependencies, just `java -jar HANA-Lens.jar`.

It works with **Full System Info Dumps (FSID)** and **HANA Support Info (HSI)** packages without requiring a running HANA system or internet access.

---

## How to start

1. Go to [github.tools.sap/D055116/HANA-Lens/releases](https://github.tools.sap/D055116/HANA-Lens/releases) and download the latest release ZIP
2. Extract the ZIP to a local folder
3. Run `start.bat` (Windows) or `start.sh` (macOS/Linux)
4. The app opens automatically in your default browser at `http://localhost:7321`
5. Open **Settings** and import the sample configuration file `hana-lens-settings.json` included in the ZIP to get pre-configured reports

> **HANA-Lens requires a Java runtime.** Install via [SapMachine](https://sapmachine.io/docs/installation) — the SAP-supported OpenJDK distribution.

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
- **Reports** — configurable report sections combining configuration data and trace file searches with a From/To time filter

---

## Settings

Settings are stored automatically in:

| Platform | Path |
|---|---|
| **Windows** | `%APPDATA%\com.sap.hana-lens\hana-lens-settings.json` |
| **macOS / Linux** | `~/.config/com.sap.hana-lens/hana-lens-settings.json` |

Each configured report is additionally stored as its own file (`hana-lens-report-<name>.json`) in the same directory, making reports easy to share and back up individually.

---

## Filter Presets

The Trace Explorer filter bar includes a preset dropdown for quick search terms. Filter presets are managed directly in **Settings → Filter Presets**: add a name and one or more comma-separated search terms per preset. Presets are saved automatically in the settings file.

Example preset named `Replication`:
```
SAPHanaReplication, replication error, log shipping
```

---

## Version check

HANA-Lens checks for new versions against this repository's tags on startup and shows a banner if a newer version is available.
