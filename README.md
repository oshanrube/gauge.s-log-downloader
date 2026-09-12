# Gauge.S Log Downloader

A lightweight progressive web app (PWA) that connects to a **Gauge.S device** over Wi-Fi, merges all CSV log files by name, and downloads them in one tap — no app install needed.

It also **diagnoses** those logs on the device: likely faults, ranked, with the evidence for each one. See [Engine diagnosis](#engine-diagnosis-analyse-tab).

🌐 **Live app:** https://oshanrube.github.io/gauge.s-log-downloader/

📱 **Android app (deleting works):** [**Download the APK**](https://github.com/oshanrube/gauge.s-log-downloader/releases/latest/download/gauge-s-downloader-latest.apk) · [all releases](https://github.com/oshanrube/gauge.s-log-downloader/releases/latest)

> **"Delete after download" only works in the Android app.** The browser blocks
> it: a cross-origin `DELETE` is preceded by an `OPTIONS` preflight that the
> device firmware doesn't answer, so the delete never reaches the device. The
> app sends its requests through the OS HTTP stack instead, so there's no
> preflight — and it pins its sockets to the Gauge.S Wi-Fi, so the device stays
> reachable while Android reports "no internet". Build details: **[NATIVE.md](NATIVE.md)**.
>
> Everything below applies to the web app and is unchanged.

![Scan to open app](https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=https://oshanrube.github.io/gauge.s-log-downloader/&margin=8)

---

## How to Use (Mobile)

Follow these steps **in order** each time you want to download logs.

---

### Step 1 — Load the app & save it for offline use

You only need internet for this step. Do it once before heading to the field.

#### iPhone (Safari)

1. Open **Safari** and go to:
   ```
   https://oshanrube.github.io/gauge.s-log-downloader/
   ```
2. Wait for the page to fully load (the service worker will cache it in the background).
3. Tap the **Share** button at the bottom of the screen (box with an arrow pointing up).
4. Scroll down and tap **"Add to Home Screen"**.
5. Tap **Add** — the app icon will appear on your Home Screen.

#### Android (Chrome)

1. Open **Chrome** and go to:
   ```
   https://oshanrube.github.io/gauge.s-log-downloader/
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

> **Device on a different IP?** The **Device** field at the top is a dropdown as
> well as a text box. Type a new address once and it is remembered; after that,
> tap the **▾** button and pick it from the list — handy when the same Gauge.S
> answers on `192.168.4.1` on its own Wi-Fi but on another address once it is
> joined to a workshop router. The eight most recently used addresses are kept,
> most recent first, and the **×** next to an entry forgets it.
>
> The field is locked when you open the app from the device itself
> (`http://<ip>/index.html`) — there is nothing to choose in that case.

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
| "Delete after download" always fails | Expected in the browser — the `DELETE` is stopped by a CORS preflight the firmware doesn't answer. [Install the Android app](https://github.com/oshanrube/gauge.s-log-downloader/releases/latest/download/gauge-s-downloader-latest.apk). |

---

## Engine diagnosis (Analyse tab)

The app reads a merged log and reports likely faults, with the evidence for
each one. This is the Car Doctor pipeline, ported from Kotlin so it runs in the
web app and the Android app alike — that project is retired and this is now the
only copy.

📖 **[How it decides something is wrong](https://oshanrube.github.io/gauge.s-log-downloader/docs/how-it-works.html)**
— a plain-English walkthrough with diagrams, for anyone who wants to know what
the report is actually telling them. The rest of this section is the technical
summary.

**Analysis runs entirely on the device.** A drive log is never uploaded; the
diagnosis needs no internet at all, which matters because the field where you
collect logs is usually the field with no signal.

Pick a merged log on the **Analyse** tab and tap **Analyse**. The report lists
findings worst-first, each with the numbers it reasoned from and the checks
worth doing — plus what the log covered, and what could *not* be checked.

```
CSV ─▶ 1 Ingest ─▶ 2 Condition ─▶ 3 Segment ─▶ 4 Aggregate ─▶ 5 Detect ─▶ 6 Rank
       (stream)     (validity)     (states)     (fixed size)   (declarative) (root cause)
```

1. **Ingest** — streams one row at a time and never materialises the file. A
   channel alias map normalises `"engine speed (RPM)"`, `"RPM"` and
   `"Engine Speed"` onto one canonical channel, so a new logger format never
   touches a detector. Gauge.S and RomRaider logs both work.
2. **Condition** — puts samples on a uniform grid, because the log rate is not
   the data rate. Every channel is classified as OK, absent, constant or
   implausible; detectors needing a bad channel are *skipped and reported*,
   never guessed.
3. **Segment** — labels every sample with an operating state: warm idle, steady
   cruise, throttle transient, full-load pull, overrun, warm-up. This is the
   backbone. Almost no engine measurement is good or bad on its own — it is good
   or bad *for a given operating state*. A 15% fuel trim is alarming at steady
   cruise and unremarkable 200 ms into a throttle stab.
4. **Aggregate** — the drive collapses into a fixed-size summary. A ten-minute
   log and a six-hour log produce a summary of the same size, so memory never
   grows with drive length.
5. **Detect** — each rule declares the channels it needs, the states it is valid
   in, and how many seconds of evidence it requires. The framework enforces all
   three before the rule runs, so an author cannot forget an evidence gate.
6. **Rank** — findings sharing a cause are grouped, so one fault reads as one
   diagnosis with three pieces of evidence rather than three separate repairs.

The file is read twice. Knock cannot be judged from ignition advance alone —
advance is *supposed* to fall as load rises, which is the shape of every spark
map ever calibrated. The first pass learns this engine's own ignition map (and
where its throttle actually rests, which is not always zero); the second judges
timing against it. Buffering the samples instead is precisely the thing that
must not scale with drive length.

A quiet report means nothing matched the rules that could be run — not that the
engine is healthy. The "not checked" list is part of the output for that reason.

### Tests

```bash
npm test
```

The pipeline has no compiler to catch it going wrong: a broken detector still
builds, installs and runs, and simply reports the wrong thing. The suite carries
the assertions that stop that shipping — including the regressions that each
guard was added for, such as a throttle sensor reading 0.0% through three
quarters of a drive, and a normal spark map being mistaken for knock. CI runs it
before building the APK.

### Richer logs, better answers

Detectors degrade honestly when a channel is missing, and upgrade when a better
one is present. Given only ignition advance, the knock rule has to reconstruct a
spark map and still only concludes "timing looks low for these conditions".
Given a log carrying the ECU's own knock correction, it simply reads how many
degrees were pulled — and the inferred rule stands down, so one fault is never
reported twice at two different confidences.

Worth logging if your software offers them: knock correction, cam advance
(AVCS/VANOS/VVT), both bank fuel trims, radiator temp, battery/system voltage,
oil temp, fuel pressure.

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
