# Optional auto-load folder

Commit the daily CSV exports here and rename `manifest.example.json` to `manifest.json`.
The dashboard fetches the manifest on open and loads every listed file, so the page
comes up populated without an upload step.

`kind` is either `leads` or `spend`. Spend entries also need `platform`
(`Google`, `Meta` or `Other`) because the two spend exports are structurally identical.

Uploaded files always override what the manifest loaded.
