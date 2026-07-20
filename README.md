# Civitai Night Harvest

Desktop app for **automated Civitai browsing, night crawl, and downloads**.  
Saves models in a **SwarmUI-friendly** layout: `.safetensors`, preview image, and `.swarm.json` metadata.

> **Testing note:** Download flow is tested mainly with **LoRA** models. Checkpoint support is included but not fully verified yet.

Repository: [github.com/pastuh/Civitai-Night-Harvest](https://github.com/pastuh/Civitai-Night-Harvest)

---

## What it does

- **Harvest** — walks enabled Browse rules against the Civitai API (catalog **backfill** page by page, then **peek** for newest); queues and downloads in the background
- **Browse rules** — Civitai search filters (model type, base model, keywords, sort, SFW/NSFW, creator)
- **Quiet gallery (👁)** — hide Browse cards while harvest runs (lighter UI); downloads continue. **Show Browse snapshot** loads what is already in memory and turns live gallery back on
- **Results gallery** — live updates when 👁 is off; search by name/author; sort, tag filter, content filters; Loaded / Owned / New / Updates / Awaiting / Banned stats
- **Model details** — full-page view from Browse, Library, Updates, etc.: sticky toolbar, versions on the right (with dates), per-version download, Load/Save preview for owned versions
- **Version-specific previews** — Updates/Browse/download cards use that version’s image (not one shared model thumbnail)
- **Download modes** — **Auto** (auto-queue from harvest, up to 10 in pipeline) or **Manual** (click cards); **Pause** stops file downloads only — harvest/API can keep running and fill the queue
- **Clear queue** — empties the download strip; does not switch Auto/Manual or enable Pause
- **Local library** — SQLite inventory, duplicate detection by version, tag-based folder routing; tab badge **+N** for new downloads since last Library visit
- **API host** — search/crawl use **civitai.red** (fixed)
- **Queue & retries** — download strip with progress, priority, color-coded states; awaiting-access / early-access; **Updates** tab for owned-model version updates (filled during Harvest + background API check; optional auto-download in Settings)
- **Activity log** — crawl and download history (verbosity configurable in Settings, including Off)
- **Bottom status bar** — API fetch / peek wait / queue summary (works with quiet harvest)
- **Settings** — backfill vs peek interval, strip layout/visibility, results windowing (lazy / pages / auto-advance), **Preserve filters**, optional optimization slider

For UI details, open the in-app **Help** tab.

---

## Header controls

| Control | Purpose |
|--------|---------|
| **Harvest** | Start/stop continuous catalog crawl (+ scheduled peek). There is no separate Scan button. |
| **Auto / Manual** | Auto-queue eligible models vs manual queue only |
| **Pause** | Stop active downloads (harvest continues unless you turn Harvest off) |
| **👁** | Quiet ON = hide Browse cards; Quiet OFF = live gallery during harvest |
| **Clear queue** | Remove items from the strip (does not change Auto/Manual or Pause) |

---

## Harvest & backfill

With **Backfill older catalog pages** on (default):

1. On each app session / Harvest start, walk **all** catalog API pages for enabled rules (~100 models per page until the catalog ends).
2. Then switch to **peek-only** — re-check the newest page on the **Newest peek** interval (default 15 min).

With backfill off, continuous harvest relies on peek / “queue all” settings instead of a full catalog walk.

Turning **Harvest off** currently clears the in-memory Browse gallery. To review models without more API work: keep Harvest on, use **Pause**, and turn 👁 off (or use snapshot).

---

## Updates tab

For **models you already own**, when Civitai has **missing same-base versions** (not only the newest). This is **not** brand-new models (those show as Browse **New**). If enabled Browse Rules set `baseModels`, that filter applies too:

1. **During Harvest** — as catalog pages are fetched, matching owned-model missing versions are added here (or auto-queued if **Settings → Auto-download new versions** is on).
2. **Background check** — after startup / during Harvest peek, the app also polls owned models via Civitai `GET /models/{id}` (one request per model — **not** SHA256). Models successfully checked within the **last 2 days** are skipped. Manual **Check again** forces a full re-poll.

Cards show **Versions: owned/total**, the version name, and a **version-specific** preview. Use **Queue / Sync / Show List / Ban**. **Show List** opens Library on **All models** pinned to that model (not Session downloads).

Brand-new models (not in your library) appear as Browse **New** and are handled by Harvest Auto-queue — they do not belong on this tab.

---

## Library tab

- **+N badge** — downloads since you last opened Library; opening Library **with a badge** selects **Session downloads** so you can review what just arrived
- **Session downloads** — everything added to the library during this app run
- **Downloaded by date** — Today / Yesterday / Last 7 days, day or from–to pickers, and days that have downloads
- **Show List** (from Updates / details) — pins one model under **All models** (does not force Session)
- Sort, content filter, tag sidebar, per-card folder assignment
- **ℹ** opens **Model details** (same full page as Browse)

---

## Browse Results

- **Search** — filter gallery by model or author name
- **Filters** — content (All/SFW/NSFW), hide owned, excluded, blocked tags, awaiting access, **Show updates** (owned-model updates); ban mode toggle
- **Stats** — Loaded = Owned + New + Updates + Awaiting + Blocked + Banned (categories do not overlap). **New** = not in library (eligible to auto-queue). **Updates** = newer/missing versions of a model you already own (confirm on Updates tab)
- **Sort** — folder tag, Civitai downloads, or download order
- **Tags** — popover filter from tags seen in results
- **Gallery settings** — optionally move owned/excluded/awaiting cards to the end; dim them; results display mode (lazy / pages / auto-advance)
- **Model details** — ℹ opens full-page details with per-version actions and previews

---

## Preserve filters

**Settings → Preserve filters** keeps Browse and Library filter, sort, and show/hide checkboxes when you switch tabs (until you change them yourself). Off = filters reset when the tab unmounts (previous behavior).

---

## Download strip layout

Settings → **Download strip** visibility and layout:

| Mode | Description |
|------|-------------|
| **Row** | Horizontal scroll of thumbnail cards |
| **Grid** | Wrapped rows of thumbnail cards |
| **Minimal** | Compact list with inline progress |

Also adjust **Download strip card size** for Row and Grid modes.

---

## Quick start

1. **Settings** → set **LoRA** and **Checkpoint** folders plus Civitai **API key** for NSFW/restricted content.
2. **Browse** → **Rules** → enable at least one rule → **Save rules**.
3. Click **Harvest** in the header (leave **Backfill** on for a full catalog pass).
4. Use **Auto** for hands-off queueing, or **Manual** and click cards. Turn off **Pause** to download.
5. Optional: press **👁** for a quieter UI while harvest runs; use **Show Browse snapshot** when you want to see cards again.

Optional: **Tag Folders** tab maps Civitai tags to subfolders on disk.

---

## NSFW & API key

Many NSFW and restricted models need a Civitai API key. Without one, downloads may fail (403) or appear under **Awaiting access**.  
Mature content on **civitai.red** often requires a key.

Create a key at [civitai.com](https://civitai.com) → Account → **API Keys**.

---

## Development

Requirements: **Node.js 20+**, **npm**

```bash
git clone https://github.com/pastuh/Civitai-Night-Harvest.git
cd Civitai-Night-Harvest
npm install
npm run dev
```

## Build

```bash
npm run build
```

Installer/portable output under `dist/` when packaged with electron-builder.

---

## License

See the repository license file if present.
