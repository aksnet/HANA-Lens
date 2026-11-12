## What's new in v2026_11_12_02

### Filter Presets — individual files + new accordion UI

Filter Presets now work the same way as Reports: each preset is stored as its own file (`hana-lens-filter-<name>.json`) in the settings directory, and the Settings panel has been rebuilt as a collapsible accordion.

- **Export / Import** individual presets via the ⬇ / ⬆ buttons per preset card
- **Delete** individual presets with 🗑 Delete Preset
- **Migration**: existing presets in `hana-lens-settings.json` are automatically written to individual files on first launch
- Duplicate name validation (red border + save blocked)

### Reports (from v2026_11_12_01)

- Each report stored as `hana-lens-report-<name>.json` in the settings directory
- Export / Import individual reports
- Delete entire reports with 🗑 Delete Report
- Accordion UI in Settings → Reports

### README

Updated to reflect the current Java implementation, settings paths, and the new per-file storage for both Reports and Filter Presets.
