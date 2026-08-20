# PropertyPistol · Performance Intelligence Dashboard

A static, browser-only dashboard that joins daily Google Ads spend, Meta Ads spend and the CRM lead dump into one view: platform and campaign performance, daily and weekly trends, lead quality, and an automatic pattern-detection feed.

Everything runs in the browser. No server, no database, no data leaves the machine.

---

## Repository layout

```
index.html
assets/
  css/style.css
  js/parse.js          file reading, encoding detection, comment-log parsing
  js/analytics.js      aggregation, statistics, drill-down, funnels, pattern detection
  js/audit.js          lead audit rule catalogue and scoring
  js/charts.js         Chart.js theme and chart builders
  js/app.js            state, filters, uploads, view rendering
data/                  optional — commit CSVs here for auto-load
.nojekyll
```

## Hosting on GitHub Pages

1. Create a repository and upload every file, keeping the folder structure.
2. Settings → Pages → Source: **Deploy from a branch** → Branch: `main`, folder: `/ (root)`.
3. Open `https://<user>.github.io/<repo>/`.

`.nojekyll` is included so GitHub serves the `assets` folder as-is.

## Daily use

Open the **Uploads & Log** tab. There is one drop zone per file type:

| Zone | File | Tagging |
| --- | --- | --- |
| CRM lead dump | `leads_YYYY-MM-DD.csv` | — |
| Google Ads spend | the day-wise spend export | tagged Google on load |
| Meta Ads spend | the other day-wise spend export | tagged Meta on load |
| Saved session | `pp_session_*.json` | restores everything saved earlier |

Files load the moment they land — no staging step, no Apply button, no platform dropdown to forget. Drag a file onto a box, click **Choose file**, or click anywhere inside the box to open the picker. The two spend exports are structurally identical (same headers, same account name), so the box you use is what sets the platform. Drop a file in the wrong box and it is rejected with a note rather than loaded incorrectly.

Each box shows its own live status — reading, loaded with the row count and total, rejected, or failed with the reason. Anything that goes wrong also appears in a red banner at the top of the tab, and the **Diagnostics** card at the bottom reports whether the CDN libraries loaded, whether the drop zones are wired, how many files have been picked, dropped and read, the last event seen and the last error. If a file ever refuses to load, that card says why.

Every load writes a row to the **upload log**: time, zone, file name, status, rows in the file, how many were new, the date span covered and a note. Rejections and failures are logged too, so a quiet mistake at 9am is visible at 6pm. The log downloads as CSV and travels inside the session file.

Re-uploading is safe. Leads de-duplicate on lead number, spend rows on date plus platform plus account, with the newest file winning. **Clear leads**, **Clear spend** and **Clear everything** sit at the bottom of the tab, and each writes to the log.

**Session files.** The browser holds nothing between visits by design. Press **Save session** to download a JSON snapshot of every lead, spend row and log entry, and load it back the next day before adding new files. That is how weekly trends and the audit history build up.

## Optional: auto-load from the repository

Commit the daily CSVs into `data/` alongside a `manifest.json` and the dashboard loads them on open — no upload step.

```json
{
  "files": [
    { "path": "leads_2026-08-20.csv", "kind": "leads" },
    { "path": "google_2026-08-20.csv", "kind": "spend", "platform": "Google" },
    { "path": "meta_2026-08-20.csv",   "kind": "spend", "platform": "Meta" }
  ]
}
```

Rename `data/manifest.example.json` to `data/manifest.json` to switch this on. Uploaded files always take precedence over what the manifest loaded.

## Tabs

- **Overview** — headline KPIs, spend versus leads, CPL trend with a 7-day average, budget split, top projects, and the most important auto-detected findings.
- **Spend Drill-Down** — an expandable project → platform → campaign tree carrying spend, leads, QL, TBD, unqualified, QL rate, CPL, CPQL, visits and EOI on every level. Each row states how it got its spend: `matched` where the export ties spend to a campaign name, `apportioned` where it is spread by lead share within the platform, `estimated` where a platform has spend but no tagged leads. Strict mode shows only matched spend and reports the rest as unallocated. The whole tree exports to CSV with the level, project, platform and campaign in separate columns.
- **Platforms** — Google versus Meta on daily spend, share of budget, cumulative pace, weekday averages, and a full scorecard.
- **Campaigns & Projects** — group by project, campaign, city, source, ad set or owner; red/green flagging against the CPL threshold; volume-versus-quality bubble chart and a sortable table.
- **Trends** — daily or weekly granularity, selectable metrics, week-on-week deltas, and cumulative pacing against an even-spend line.
- **Pattern Radar** — insight feed, least-squares direction of travel, spend-to-lead correlation at 0–3 day lags, weekday index heatmap, anomaly log at two standard deviations, and project-level quality outliers.
- **ASM Dashboard** — the conversion chain: lead → QL, QL → visit, visit → EOI or booking, plus lead → booking. Roll up by ASM, team, every manager in the chain, pre-sales owner or city, with a volume floor so thin rows do not distort the ranking. The ASM comes from the first real name on the lead's manager chain; account-wide names and team tags are stripped out.
- **Lead Audit** — sixteen rules run over the CRM comment log and timestamps: never contacted, SLA breach, missed callback, no next call scheduled, gone quiet, repeated attempts without a connect, WhatsApp only, dead without a reason, killed too fast, buying signal not actioned, log says dead while the status does not, qualification overdue, qualified with no visit plan, unassigned, slow to assign, and follow-up stamped with nothing written. Thresholds are editable in the toolbar. Output is an audit score out of 100 per lead and per owner, a rule breakdown, a classification of every comment, and an action list filterable by severity and exportable to CSV.
- **Lead Quality** — funnel, sub-status and dead-reason breakdowns, first-response distribution, city qualification mix, and a team leaderboard.
- **Data Tables** — the daily master, every lead and every spend row, searchable, sortable and exportable.
- **Uploads & Log** — the drop zones, the upload log and the current load state.

## How the audit reads the comment log

The CRM stacks comments in one cell as `DD-MM-YY HH:MM AM (Agent) : text`. Each entry is split out with its timestamp and author, then classified as a real conversation, a visit discussion, a callback request, no answer, a message drop, a rejection or an unclassified note. That classification is what lets the audit say "three attempts, never once connected" or "the log reads as a rejection but the lead is still open" instead of just counting fields.

Timings are measured against the latest activity in the file, not the wall clock, so an audit run on a week-old export still reports what was true when the export was taken.

## Filters

The filter bar applies to every tab: date range (with a **Spend ∩ Leads** default that clips to the window both files actually cover), plus multi-select city, project and platform. The **CPL red line** on the Campaigns tab defaults to ₹3,000 and drives the red/green flags everywhere.

## Reading the numbers honestly

- **Blended CPL** is all spend divided by all leads in the window. It is the headline number, and it is only a channel CPL when the leads in the window actually came from the ads.
- **Platform-tagged CPL** divides the same spend by leads the CRM tagged as Google or Meta. When the tagged share is low, this is the number to argue with.
- The coverage bar under the header always states the date span of each file and the share of leads carrying a campaign tag. If the two files do not span the same dates, the bar turns amber — CPL means nothing outside the overlap.
- Days with spend and zero leads, and days with zero spend, are called out separately rather than averaged away.

- Visits, EOI and bookings come from `Visited`, `Visited Date` and `Booking Date` where the CRM fills them, and from the sub-status and comment log where it does not. When a stage is empty the ratio reads "no site visits in this window" rather than a misleading percentage.

In the 20 August sample files, every lead arrived from MyGate with no campaign tag, so the dashboard flags the blended CPL as directional, shows the tagged CPL as empty, and marks every drill-down row as apportioned. Once the lead dump carries `utm_campaign`, `Campaign Name` or `GClickID` values, platform and campaign attribution populate automatically with no changes to the code.

## Dependencies

Loaded from CDN at runtime: Chart.js 4.4, PapaParse 5.4, Inter and JetBrains Mono. Nothing to install or build.
