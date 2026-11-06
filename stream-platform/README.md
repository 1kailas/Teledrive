# Folio — Cloudflare Streaming Platform

A cinema streaming room and lossless audio player powered by Telegram and TeleDrive. Designed to run **100% independently** on Cloudflare Pages without needing the TeleDrive desktop app or computer running.

---

## 🌟 Key Capabilities

- **Pure On-Demand Streaming**: Uses HTTP `206 Partial Content` with `Range` seeking. You can scrub to minute 50 of a 10 GB film and it starts streaming immediately without pre-downloading the entire movie.
- **Independent Cloud Hosting**: Runs on Cloudflare Pages + Pages Functions edge workers. Connects directly to Telegram's cloud storage via Telegram Bot API so you never have to leave your computer or desktop app turned on.
- **Multi-Audio Track Switching**:
  - Support for multi-audio language streams (`video.audioTracks`), e.g., English, Hindi, Commentary, 5.1 surround.
  - Floating Audio Settings menu right on the player.
- **Studio DSP Equalizer & Vocal Booster (Web Audio API)**:
  - 🗣️ **Clear Dialogue**: Peaking +8.5dB at 2.4 kHz to enhance voices over explosions and background scores.
  - 🌙 **Night Mode**: Dynamic range compressor + voice boost to tame loud gunshots while lifting whisper scenes.
  - 🔊 **Cinema Bass**: +7.5dB low-shelf impact for home-theater punch.
  - ⚡ **Extra Loud 150% / 200%**: Clean gain amplification for quiet laptop and phone speakers.
- **Playback Speed**: 0.5x, 0.75x, 1.0x, 1.25x, 1.5x, 2.0x with pitch correction.
- **Subtitles & Captions**: Automatic embedded track detection + one-click upload for external `.srt` and `.vtt` subtitle files.
- **Cinema Features**: Fullscreen toggle (`F`), Picture-in-Picture (`P`), keyboard shortcuts HUD, and localStorage watch-time resumption.
- **Broad Movie & Audio Format Support**:
  - Video: `.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`, `.m4v`, `.ts`, `.3gp`, `.flv`, `.wmv`.
  - Audio: `.mp3`, `.m4a`, `.wav`, `.flac`, `.ogg`, `.opus`, `.aac`, `.weba`.

---

## 🚀 Cloudflare Pages Hosting (Step-by-Step)

### Option 1: Git Integration (Recommended)
1. Go to your [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
2. Select your repository.
3. In **Build Settings**:
   - **Framework preset**: `Vite`
   - **Root directory**: `stream-platform`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
4. In **Environment Variables** (Production):
   - `BOT_TOKENS`: comma-separated bot tokens used by the uploaded media parts
     *(use every bot that owns parts in the catalog; a single-bot library can
     use `TELEGRAM_BOT_TOKEN` instead)*
   - `ALLOW_PUBLIC`: `true`
     *(Optional: if using Cloudflare Access instead of public access, add `ACCESS_TEAM` and `ACCESS_AUD`)*
5. Click **Save and Deploy**. Your streaming platform will be live at `https://<your-project>.pages.dev`!

---

### Option 2: Direct Upload via Wrangler CLI
From the repository root:
```bash
cd stream-platform
npm run build
npx wrangler pages deploy dist --project-name folio-stream
```
Then set the secret in Cloudflare Pages dashboard:
- `BOT_TOKENS`: comma-separated bot tokens for the bots that own the media parts
  *(or `TELEGRAM_BOT_TOKEN` for a single-bot library)*
- `ALLOW_PUBLIC`: `true`

---

## 🧪 Local Development

To run locally with live mock or local media:
```bash
npm run dev --prefix stream-platform
```
Open [http://localhost:5174](http://localhost:5174).

The committed `public/catalog.json` is the real library snapshot. `npm run build`
never regenerates it, so a deploy from a machine without the local TeleDrive
database cannot replace it with an empty catalog.

To refresh the snapshot from the real TeleDrive library:
```bash
npm run export-catalog --prefix stream-platform
```

The exporter discovers ready video/audio files from the TeleDrive data
directory (or `TELEDRIVE_DATA_DIR` / `TELEDRIVE_JSON` / `TELEDRIVE_SQLITE`),
probes real durations, preserves verified cloud editions, and prunes stale
entries. Commit the updated snapshot to publish it.

Hosted playback uses the public Telegram Bot API, which only serves documents
up to 20 MiB. Media uploaded with larger parts stays visible in the catalog but
needs a cloud edition with 20 MiB parts (see `data/stream-editions/`) before it
can stream from Cloudflare Pages.

To run test suite:
```bash
npm test --prefix stream-platform
```
