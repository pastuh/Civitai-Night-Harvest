# Civitai Night Harvest

Desktop app for **automated Civitai browsing, night crawl, and downloads**.  
Saves models in a **SwarmUI-friendly** layout: `.safetensors`, preview image, and `.swarm.json` metadata.

> **Testing note:** Download flow is tested mainly with **LoRA** models. Checkpoint support is included but not fully verified yet.

Repository: [github.com/pastuh/Civitai-Night-Harvest](https://github.com/pastuh/Civitai-Night-Harvest)

---

## What it does

- **Harvest** — walks your Browse rules through the Civitai catalog, then peeks for newest models; queues and downloads in the background
- **Browse rules** — search filters (model type, base model, keywords, sort, SFW/NSFW, creator)
- **👁 Quiet gallery** — hide Browse cards while harvest runs; downloads continue. **Show Browse snapshot** brings cards back
- **Browse results** — search, filters, sort, tags; progress stats: Loaded, Owned, Yield, Updates, Awaiting, Banned
- **Model details** — full page with versions, download, and preview save
- **Auto / Manual / Pause** — auto-queue from harvest, click-to-queue, or pause downloads
- **Library** — local inventory; Excluded tags, Fast tag, All assigned; session and date filters; tab **+N** for new downloads
- **Tag Folders** — map Civitai tags to `\*\name` folders; **Mass** assign; per-tag **Priority**; **Ban** column for permanent ban-by-tag; unmatched downloads go to `\*\Unsorted`
- **Missing** — 404 reviews, paused/banned-by-tag skips, manual bans; **Mark seen** / **Hide seen** / **Unseen bans** filter; per-model **Allow**; **Forget** (hide everywhere); right-click context menu; click a policy tag to filter that skip list
- **Incomplete** — Civitai models with empty version data; recheck API or paste a download URL
- **Updates** — newer versions of models you already own (Queue / Ban / Dismiss); right-click context menu; shows tags from your existing library copies
- **Download strip** — progress, priority, retries; Early access when a model is gated
- **Activity** — crawl and download history
- **Status bar** — fetch, wait, and queue summary at the bottom
- **Settings** — folders, API key, harvest timing, strip layout, results display, preserve filters, confirm tag moves

Open the in-app **Help** tab for a short UI guide.

---

## Header controls

| Control | Purpose |
|--------|---------|
| **Harvest** | Start or stop continuous catalog crawl |
| **Auto / Manual** | Auto-queue matches, or queue only cards you click |
| **Pause** | Pause file downloads |
| **👁** | Hide or show Browse cards during harvest |
| **Blur** | Hide preview thumbnails |
| **Clear queue** | Empty the download strip |

---

## Harvest

With **Backfill older catalog pages** on (default):

1. Walk catalog pages for enabled rules until the catalog ends.
2. Then peek the newest page on the **Newest peek** interval (default 15 min).

---

## Updates

For models you already own, when a newer matching version appears:

1. During Harvest, matching updates are listed (or auto-queued if **Auto-download new versions** is on).
2. A background check also looks for updates on owned models.

Use **Queue**, **Ban**, **Dismiss**, or **Show List** (opens Library on that model).  
**Right-click** a card for the context menu (Queue, Always Update, Ban, Open on Civitai).  
Cards show **tags** from your existing library copies of that model.

---

## Library

- **+N** — new downloads since you last opened Library (opens **Session downloads**)
- **Session downloads** — everything added this app run
- **Downloaded by date** — Today / Yesterday / 7 days, or a calendar (one day, or click two days for a range); shows download count for the selection
- **Excluded** — tags ignored when **Hide folder-assigned** + **Ignore excluded** are on (e.g. keep `concept` models visible)
- **All assigned** — temporarily hide folder-mapped tags on cards (dashed placeholder shows tags were hidden)
- **Fast tag** — click a card tag to assign a folder (`\*\name`) without leaving Library; optional confirm dialog
- **Manual** badge — models assigned by hand are not re-routed by auto tag moves / priority
- Sort, filters, tag sidebar, folder assignment
- **ℹ** — Model details

---

## Tag Folders

- Map Civitai tags to disk under each base model: `\*\folder` (or a custom absolute path)
- **Mass** — select many tags and assign one folder name
- **Priority** — when a model matches several tags, higher wins (▲/▼; skips `0`). Equal priorities: first matching tag. Manual Library assigns always win
- **Ban** — permanent ban-by-tag (skip auto-download). Temporary pause is Browse → **Paused** only
- No matching Tag Folders rule → `\*\Unsorted` under the version’s base model (not the shared base-model root)
- Settings → **Confirm before bulk tag-folder moves** — turn off to skip the “how many models?” dialog
- **Sync folders** also rewrites old invented `Suggested LoRA strength: 0.6–1.0` lines in `.swarm.json` using Civitai description text (API has no dedicated weight field)

---

## Missing

- **404 / Suspect** — Civitai not found; recheck and acknowledge
- **Paused by tag** — temporary Browse exclude; **Banned by tag** — permanent Tag Folders ban
- **Banned manual** — model ban from Library/Browse
- **Mark seen** — move pointer left/right off a ban/pause card to mark seen (green title border). **Hide seen** checkbox removes marked cards. **Unseen bans** sidebar filter shows only unseen; newly marked items stay visible until you check Hide seen.
- Per model: **Allow** (exception vs pause/ban tags + queue) or **Forget On** → × (hide everywhere; **Show forgotten** to review)
- **Right-click** a card for context menu (Mark seen, Forget, Unban, Allow, Acknowledge, Open on Civitai)
- Click a policy tag (sidebar or card) → filter models skipped for that tag. Opening Model details keeps Missing filters and scroll

---

## Incomplete

- Models Civitai lists without usable `modelVersions` data
- **Recheck API** or paste a download URL to resolve; Ban excludes from harvest

---

## Browse

- **Search** — by model or author
- **Filters** — content, hide owned, paused tags (temporary), banned tags (read-only; edit in Tag Folders), awaiting, show updates; ban mode
- **Paused** bar — temporary exclude tags (amber chips on cards)
- **Banned** bar — permanent ban-by-tag list (purple chips; manage in Tag Folders)
- **Yield** — how many models entered the download strip this session (grows as you queue / Auto sends)
- **Sort & Tags** — arrange and filter the grid (⏸ pause a tag from the Tags popover)
- **ℹ** — Model details

---

## Preserve filters

**Settings → Preserve filters** keeps Browse and Library filters when you switch tabs. Missing keeps its filters while Model details / Tag Folders overlays are open.

---

## Download strip

| Mode | Description |
|------|-------------|
| **Row** | Horizontal scroll of cards |
| **Grid** | Wrapped card grid |
| **Minimal** | Compact list with progress |

Card size is adjustable for Row and Grid.

---

## Quick start

1. **Settings** → LoRA and Checkpoint folders; API key for NSFW if needed.
2. **Browse → Rules** → enable a rule → **Save**.
3. Press **Harvest** (Backfill on for a full catalog pass).
4. **Auto** for hands-off queueing, or **Manual** and click cards; turn **Pause** off to download.
5. Optional: **👁** for a quieter harvest UI; snapshot or turn 👁 off to see cards again.
6. Optional: **Settings → Sync library from disk** when you import/move files, fix swarm hints, or check for tiny/truncated downloads (not run on every app launch).

Use **Tag Folders** (and Library **Fast tag**) to map Civitai tags to subfolders on disk.

---

## NSFW & API key

Many NSFW and restricted models need a Civitai API key. Create one at [civitai.com](https://civitai.com) → Account → **API Keys**.

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
