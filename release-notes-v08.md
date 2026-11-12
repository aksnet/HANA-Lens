### New Feature: Individual Report Files

Each report is now stored as its own JSON file in the settings directory:

- **Windows**: `%APPDATA%\com.sap.hana-lens\hana-lens-report-<name>.json`
- **macOS**: `~/.config/com.sap.hana-lens/hana-lens-report-<name>.json`

On startup, HANA-Lens scans the settings directory for `hana-lens-report-*.json` files and loads them as the reports list. Existing reports in `hana-lens-settings.json` are migrated to individual files automatically on first launch.

### New Feature: Report Export / Import

Reports can now be shared between installations:

- **⬇ Export** button in each report accordion header — downloads the report as a `hana-lens-report-<name>.json` file
- **⬆ Import** button next to "+ Add Report" — imports a report from a JSON file; if the title already exists, a numeric suffix is appended automatically (e.g. "Replication 2")
- Duplicate title validation: the title input turns red if a duplicate is detected; saving is blocked until all titles are unique

### Improvements

- Reports section shows a placeholder message when no reports are configured
- Nav tree shows "No reports defined" instead of "Define in Settings…" when no reports exist
- **Delete Report** button renamed from "✕ Report" for clarity; confirmation dialog removed (Cancel in Settings discards changes)
