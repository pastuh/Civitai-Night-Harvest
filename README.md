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
- **Download strip** — confirmed file transfers, progress, and priority; access waits stay in **Early access**
- **Activity** — harvest and download history

**Ban / Unban** blocks or allows downloads and keeps owned files. **Forget** asks
before permanently removing a selected version or the entire model, including its
files and app records. A separate persistent Forget decision prevents the selection
from returning or downloading again, including after restart. Forgetting an entire
model also blocks its future versions. There is no restore list or undo; Unban
only affects reversible bans.

The **Browse** counter shows prepared downloads still waiting or downloading,
and decreases as each one finishes. Cached gallery cards and access checks do
not create a counter. In **Library**, **BAN** opens a version / entire-model
choice before changing any ban.

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

## Repair earlier downloads

After updating and restarting the app, run **Settings → Sync library from disk**.
Sync repairs invalid Swarm resolution fields such as `full` / `pruned` without
changing the model weights. Unknown dimensions are omitted so SwarmUI can use its
model defaults.

Sync also checks `.safetensors` file structure, regardless of size. Proven invalid
files (including HTML saved as weights) are renamed to `.invalid-*` backups and
removed from owned inventory. Eligible Civitai versions are added to the download
queue; resume it if paused. A failed or unavailable replacement stays unowned.
Ban, Forget and paused tags still apply. Do not use Forget to repair a download.
Unreadable/offline files are reported separately and are not assumed corrupt.

New downloads are checked before becoming model files. When Civitai publishes a
SHA256 checksum, the downloaded bytes must match it. Sync does not hash or identify
your local/custom models through Civitai. The separate **Verify library hashes**
action checks identified Civitai models only when Civitai supplies a checksum,
fetching it by version ID; your file hashes are never sent to Civitai.

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
