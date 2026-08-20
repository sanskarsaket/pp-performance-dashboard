# PropertyPistol · Performance Intelligence Dashboard

A static, browser-only dashboard that joins daily Google Ads spend, Meta Ads spend and the CRM lead dump into one view: platform and campaign performance, daily and weekly trends, lead quality, and an automatic pattern-detection feed.

Everything runs in the browser. No server, no database, no data leaves the machine.

---

## Repository layout

```
index.html
assets/
  css/style.css
  js/parse.js          file reading, encoding detection, normalisation
  js/analytics.js      aggregation, statistics, pattern detection
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

Click **Upload today's files** and drop all three exports at once:

| File | What it is | Detection |
| --- | --- | --- |
| `leads_YYYY-MM-DD.csv` | CRM lead dump | automatic |
| `Day_Wise_Spends.csv` | Google or Meta day-wise spend | automatic, platform set by you |
| `Day_Wise_Spends (1).csv` | the other platform | automatic, platform set by you |

The two spend exports are structurally identical — same headers, same account name — so the dashboard cannot tell Google from Meta on its own. Each spend file gets a **Google / Meta / Other** dropdown in the upload list; set it before pressing Apply. UTF-16 tab-separated exports are read as-is, no conversion needed.

Uploading more than once is safe. Leads are de-duplicated on lead number, and spend rows are de-duplicated on date + platform + account, with the newest file winning. Uploading each day therefore builds a longer history inside the session.

**Session files.** The browser holds nothing between visits by design. Press **Save session** to download a JSON snapshot of everything loaded, and **Load session** to restore it the next day before adding the new files. That is how the weekly trends build up over time.

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

- **Overview** — headline KPIs, spend versus leads, CPL trend with a 7-day average, budget split, top projects, and the eight most important auto-detected findings.
- **Platforms** — Google versus Meta on daily spend, share of budget, cumulative pace, weekday averages, and a full scorecard.
- **Campaigns & Projects** — group by project, campaign, city, source, ad set or owner; red/green flagging against the CPL threshold; volume-versus-quality bubble chart and a sortable performance table.
- **Trends** — daily or weekly granularity, selectable metrics, week-on-week deltas, and cumulative pacing against an even-spend line.
- **Pattern Radar** — the full insight feed, least-squares direction of travel, spend-to-lead correlation at 0–3 day lags, a weekday index heatmap, an anomaly log at two standard deviations, and project-level quality outliers.
- **Lead Quality** — funnel, sub-status and dead-reason breakdowns, first-response distribution, city qualification mix, and a team leaderboard.
- **Data Tables** — the daily master, every lead and every spend row, searchable, sortable and exportable to CSV.

## Filters

The filter bar applies to every tab: date range (with a **Spend ∩ Leads** default that clips to the window both files actually cover), plus multi-select city, project and platform. The **CPL red line** on the Campaigns tab defaults to ₹3,000 and drives the red/green flags everywhere.

## Reading the numbers honestly

- **Blended CPL** is all spend divided by all leads in the window. It is the headline number, and it is only a channel CPL when the leads in the window actually came from the ads.
- **Platform-tagged CPL** divides the same spend by leads the CRM tagged as Google or Meta. When the tagged share is low, this is the number to argue with.
- The coverage bar under the header always states the date span of each file and the share of leads carrying a campaign tag. If the two files do not span the same dates, the bar turns amber — CPL means nothing outside the overlap.
- Days with spend and zero leads, and days with zero spend, are called out separately rather than averaged away.

In the 20 August sample files, every lead arrived from MyGate with no campaign tag, so the dashboard flags the blended CPL as directional and shows the tagged CPL as empty. Once the lead dump carries `utm_campaign`, `Campaign Name` or `GClickID` values, platform and campaign attribution populate automatically with no changes to the code.

## Dependencies

Loaded from CDN at runtime: Chart.js 4.4, PapaParse 5.4, Inter and JetBrains Mono. Nothing to install or build.
