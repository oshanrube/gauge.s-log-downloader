# Gauge.S Log Downloader

A lightweight progressive web app (PWA) that connects to a **Gauge.S device** over Wi-Fi, merges all CSV log files by name, and downloads them in one tap — no app install needed.

🌐 **Live app:** https://oshanrube.github.io/guage.s-log-downloader/

![Scan to open app](https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=https://oshanrube.github.io/guage.s-log-downloader/&margin=8)

---

## How to Use (Mobile)

Follow these steps **in order** each time you want to download logs.

---

### Step 1 — Load the app & save it for offline use

You only need internet for this step. Do it once before heading to the field.

#### iPhone (Safari)

1. Open **Safari** and go to:
   ```
   https://oshanrube.github.io/guage.s-log-downloader/
   ```
2. Wait for the page to fully load (the service worker will cache it in the background).
3. Tap the **Share** button at the bottom of the screen (box with an arrow pointing up).
4. Scroll down and tap **"Add to Home Screen"**.
5. Tap **Add** — the app icon will appear on your Home Screen.

#### Android (Chrome)

1. Open **Chrome** and go to:
   ```
   https://oshanrube.github.io/guage.s-log-downloader/
   ```
2. Wait for the page to fully load.
3. Tap the **three-dot menu** (⋮) in the top-right corner.
4. Tap **"Add to Home screen"** (or **"Install app"** if shown).
5. Tap **Add** — the app icon will appear on your Home Screen.

> ✅ After this step the app is cached on your phone. You can open it any time — even without internet.

---

### Step 2 — Switch to Gauge.S Wi-Fi

1. Open your phone's **Wi-Fi settings**.
2. Connect to the **Gauge.S device's Wi-Fi network** (e.g. `Gauge.S` or similar — check your device label).
3. Your phone will warn you there is **"No Internet"** — this is expected. **Stay connected.**
   - **iPhone:** tap **"Use Without Internet"** (or **"Keep"**) when prompted.
   - **Android:** tap **"Stay Connected"** when prompted.

---

### Step 3 — Open the app & download

1. Open the **Gauge.S Downloader** icon from your Home Screen  
   *(or tap the Safari/Chrome bookmark you saved in Step 1).*
2. The page loads from cache — no internet needed at this point.
3. Tap **"Merge & Download"**.
4. The app will:
   - Fetch the list of log files from the device
   - Group and merge them by base filename
   - Download one merged CSV per group to your phone
5. Watch the **Activity Log** on screen — green ✓ lines mean success.

---

### Step 4 — Find your downloaded files

| Platform | Location |
|---|---|
| **iPhone** | Files app → **Downloads** (or Safari's Downloads pop-up) |
| **Android** | Files app → **Downloads** |

The merged files will be named like:
- `Gauge.S.csv` — all numbered session logs combined
- `Gauge.S_26-02-28_06.csv` — timestamped session logs combined

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Page doesn't load after switching Wi-Fi | Make sure you opened the app *before* switching Wi-Fi, or use the Home Screen shortcut |
| "Failed to fetch file list" error | Check that you are connected to the Gauge.S Wi-Fi and the device is powered on |
| Phone drops the Gauge.S Wi-Fi automatically | On Android, toggle off **"Auto-switch to better network"** in Wi-Fi settings |
| Downloaded file is empty | One or more source files on the device may be empty — check the Activity Log for details |

---

## How It Works

```
GitHub Pages (internet)          Gauge.S Device (local Wi-Fi)
        │                                   │
        │  1. Visit URL + cache app         │
        │◄──────────────────────────────────┤  (first visit, needs internet)
        │                                   │
        │  2. Open cached app               │
        │  (no internet needed)             │
        │                                   │
        │  3. Fetch file list  ────────────►│  GET /list?dir=/logs
        │  4. Fetch each file  ────────────►│  GET /logs/{filename}
        │  5. Merge & download to phone     │
```

- The app is a single `index.html` file with no external dependencies.
- A **Service Worker** (`sw.js`) caches the app shell on first load.
- All requests to `192.168.4.1` bypass the cache and go directly to the device.
- CSV files with the same base name are concatenated (duplicate headers removed).
