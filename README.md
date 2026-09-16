# Civitai Night Harvest

Desktop app for automated Civitai browsing and downloads.  
Saves models ready for SwarmUI: model file, preview image, and metadata.

> **Testing note:** Tested mainly with **LoRA**. Checkpoint support is included but less verified.

Repository: [github.com/pastuh/Civitai-Night-Harvest](https://github.com/pastuh/Civitai-Night-Harvest)

---

## What it does

- **Harvest** — walks your Browse rules through the Civitai catalog and downloads in the background
- **Browse** — rules, search, filters, tags; pause or ban tags; open model details
- **Auto / Manual / Pause** — auto-queue LoRA matches, or queue only what you click; Checkpoints always need a click
- **Library** — your downloaded models; filters by type, date, session, Always update, unrecognized, and unavailable on Civitai
- **Tag Folders** — map tags to LoRA subfolders; custom folders for local files and Checkpoint overrides
- **Updates** — other versions of models you already own (download, skip, forget, or ban)
- **Missing** — models Civitai no longer finds, plus tag pauses/bans you can allow or forget
- **Download strip** — progress, priority, and early-access waits
- **Activity** — harvest and download history

Delete / ban always asks for confirmation before removing files you already own.

Open the in-app **Help** tab for the full UI guide.

---

## Header controls

| Control | Purpose |
|--------|---------|
| **Harvest** | Start or stop continuous catalog crawl |
| **Auto / Manual** | Auto-queue **LoRA** matches, or queue only cards you click (**Checkpoints always need a click**) |
| **Pause** | Pause file downloads (also forced ON when you enable a Checkpoint rule) |
| **👁** | Hide or show Browse cards during harvest |
| **Blur** | Hide preview thumbnails |
| **Clear queue** | Empty the download strip |

---

## Quick start

1. **Settings** → set LoRA and Checkpoint folders.
2. **Browse → Rules** → enable a rule → **Save**.
3. Press **Harvest**.
4. **Auto** for hands-off LoRA queueing, or **Manual** and click cards; turn **Pause** off to download.
5. Optional: **👁** to hide Browse cards while harvest runs.
6. Optional: if you already have models on disk → **Settings → Sync library from disk**.

Use **Tag Folders** to organize LoRA into named subfolders after downloads.

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
