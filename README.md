# Civitai Night Harvest

Desktop app for **automated Civitai browsing, night crawl, and downloads**.  
Saves models in a **SwarmUI-friendly** layout: `.safetensors`, preview image, and `.swarm.json` metadata.

> **Testing note:** Download flow is tested mainly with **LoRA** models. Checkpoint support is included but not fully verified yet.

Repository: [github.com/pastuh/Civitai-Night-Harvest](https://github.com/pastuh/Civitai-Night-Harvest)

---

## What it does

- **Night harvest** — scans enabled Browse rules on a schedule, finds new models, queues and downloads them in the background
- **Browse rules** — Civitai search filters (model type, base model, keywords, sort, SFW/NSFW, creator)
- **Results gallery** — live crawl or manual Test; search by name/author; sort, tag filter, content filters in a compact toolbar
- **Download modes** — **Auto** (auto-queue from crawl/browse, up to 10 in pipeline) or **Manual** (click cards to queue); separate **Pause** button stops active downloads without changing mode
- **Clear queue** — empties the download strip only; does not switch Auto → Manual or enable Pause
- **Local library** — SQLite inventory, duplicate detection by version, tag-based folder routing; tab badge **+N** for new downloads since last Library visit
- **Domains** — civitai.com, civitai.red, or both (same version is not downloaded twice)
- **Queue & retries** — download strip with progress, priority, color-coded states; awaiting-access / early-access handling; **New Versions** tab for updates to owned models
- **Activity log** — compact filters; scan, crawl, and download history with live peek countdown
- **Tab badges** — Browse shows active queue count; Library shows **+N** new downloads until you open Library; New Versions and Awaiting access show pending counts

For UI details, open the in-app **Help** tab.

> **UI mode note:** In **Minimal** mode the bottom status bar shows only queue counts (downloading + in queue). **Extended** shows per-item details (active model name, progress, next queued).

---

## Header controls

| Control | Purpose |
|--------|---------|
| **Harvest** | Toggle night mode (scheduled scan + crawl) |
| **Auto / Manual** | Auto-queue eligible models vs manual queue only |
| **Pause** | Stop auto-downloads (works in both Auto and Manual) |
| **Clear queue** | Remove queued/downloading items from the strip (does not change Auto/Manual or Pause) |

---

## Library tab

- **+N badge** on the tab — how many models were downloaded since you last opened Library; clears when you visit the tab
- Sort, content filter, tag sidebar, and per-card folder assignment

---

## Browse Results

- **Search** — filter gallery by model or author name
- **Filters** — content (All/SFW/NSFW), hide owned, excluded, blocked tags, awaiting access; ban mode toggle
- **Sort** — folder tag, Civitai downloads, or download order
- **Tags** — popover filter from tags seen in results
- **Gallery settings** (Settings) — optionally move owned/excluded/awaiting cards to the end; dim them with adjustable opacity (hover restores brightness)

---

## Download strip layout

Settings → **Download strip layout**:

| Mode | Description |
|------|-------------|
| **Row** | Horizontal scroll of thumbnail cards (default) |
| **Grid** | Wrapped rows of thumbnail cards |
| **Minimal** | Compact vertical list — each row: thumbnail + queue/download info, separator, model name. A green fill grows across the info column while downloading; when it reaches the separator, the file transfer is complete. Ban, priority, and context menu work the same as other modes |

Also adjust **Download strip card size** for Row and Grid modes.

---

## Quick start

1. **Settings** → set your **LoRA folder** (and **Checkpoint** if needed) plus Civitai **API key** for NSFW/restricted content.
2. **Browse** → **Rules** → enable at least one rule → **Save rules**.
3. Click **Harvest** in the header to start automatic scan and downloads.
4. Use **Auto** for hands-off queueing, or **Manual** and click cards in Results.

Optional: **Tag Folders** tab maps Civitai tags to subfolders on disk.

---

## NSFW & API key

Many NSFW and restricted models need a Civitai API key. Without one, downloads may fail (403) or appear under **Awaiting access**.  
Mature content on **civitai.red** often requires both the `.red` domain and a key.

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
