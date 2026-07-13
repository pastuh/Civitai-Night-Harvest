# Civitai Night Harvest

Desktop app for **automated Civitai browsing, night crawl, and downloads**.  
Saves models in a **SwarmUI-friendly** layout: `.safetensors`, preview image, and `.swarm.json` metadata.

> **Testing note:** So far the download flow is tested mainly with **LoRA** models. Checkpoint support is included but not fully verified yet.

Repository: [github.com/pastuh/Civitai-Night-Harvest](https://github.com/pastuh/Civitai-Night-Harvest)

---

## What it does

- **Night harvest** — scans your Browse rules on a schedule, finds new models, queues and downloads them in the background
- **Browse rules** — Civitai search filters (model type, base model, keywords, sort, SFW/NSFW)
- **Manual queue** — click models in Results to queue only what you want; optional “manual queue” mode blocks auto-queue from crawl
- **Local library** — SQLite inventory, duplicate detection by version, tag-based folder routing
- **Domains** — civitai.com, civitai.red, or both (same version is not downloaded twice)
- **Queue & retries** — download strip (progress, priority queue, color-coded states), awaiting-access / early-access handling, new-version approval
- **Activity log** — compact filters; scan, crawl, and download history

For UI details, open the in-app **Help** tab.

---

## Quick start

1. **Settings** → set your **LoRA folder** (and Civitai **API key** for NSFW/restricted content).
2. **Browse** → **Rules** → enable at least one rule → **Save rules**.
3. Click **🌙 Harvest** in the header to start automatic scan and downloads.

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
