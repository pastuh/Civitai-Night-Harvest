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
- **Library** — local inventory, tag folders, session and date filters; tab **+N** for new downloads
- **Updates** — newer versions of models you already own (Queue / Ban / Dismiss)
- **Download strip** — progress, priority, retries; Early access when a model is gated
- **Activity** — crawl and download history
- **Status bar** — fetch, wait, and queue summary at the bottom
- **Settings** — folders, API key, harvest timing, strip layout, results display, preserve filters

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

---

## Library

- **+N** — new downloads since you last opened Library (opens **Session downloads**)
- **Session downloads** — everything added this app run
- **Downloaded by date** — Today / Yesterday / 7 days, or a calendar (one day, or click two days for a range); shows download count for the selection
- Sort, filters, tag sidebar, folder assignment
- **ℹ** — Model details

---

## Browse

- **Search** — by model or author
- **Filters** — content, hide owned, excluded, blocked tags, awaiting, show updates; ban mode
- **Yield** — how many models entered the download strip this session (grows as you queue / Auto sends)
- **Sort & Tags** — arrange and filter the grid
- **ℹ** — Model details

---

## Preserve filters

**Settings → Preserve filters** keeps Browse and Library filters when you switch tabs.

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

**Tag Folders** maps Civitai tags to subfolders on disk.

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
