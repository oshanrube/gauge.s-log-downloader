# Native build (Capacitor)

The hosted PWA cannot delete files from the device. This directory tree adds an
Android/iOS build of the **same** `index.html` that can.

---

## Why the PWA can't delete

`deleteFile()` sends `DELETE /edit` to the device. `DELETE` is not a
CORS-safelisted method, so before sending it the browser first sends
`OPTIONS /edit` as a preflight. The device firmware doesn't answer `OPTIONS`,
the preflight fails, and **the real request is never sent** — the device never
even sees the delete.

There is a second, independent blocker: the app is served from
`https://oshanrube.github.io` while the device is plain `http://192.168.4.1`,
which is mixed content.

Both rules are enforced by the *browser*, not the device. A native HTTP client
has no origin, sends no preflight, and has no mixed-content rule.

```
PWA:     fetch() ──► OPTIONS /edit ──► (no answer) ──► ✗ blocked, DELETE never sent
Native:  OS HTTP ─────────────────────────────────────► DELETE /edit ──► ✓
```

> A plain WebView wrapper does **not** fix this — WebViews enforce CORS exactly
> like the browser. The request has to be issued by native code, which is what
> `CapacitorHttp` does here.

---

## What the native build changes

| Area | Web | Native |
|---|---|---|
| Device requests | `fetch()` | `CapacitorHttp` → OS HTTP stack |
| Delete | blocked by preflight | works |
| Saving merged CSVs | `<a download>` | `Filesystem` plugin + share sheet |
| Cleartext `http://` | blocked as mixed content | allowed (see config below) |
| Wi-Fi with no internet | requests may leave via mobile data | sockets pinned to Wi-Fi |
| Service worker | registered | skipped (shell ships in the binary) |

`index.html` is shared by both builds and branches on `IS_NATIVE`. Nothing about
the web/GitHub Pages behaviour changes.

---

## Prerequisites

- Node 18+
- **Android:** Android Studio (JDK 17+, SDK 35)
- **iOS:** macOS, Xcode 15+, CocoaPods

## Build

```bash
npm install
npm run sync          # copies the app shell into www/, then runs `cap sync`
```

Then either:

```bash
npm run open:android  # opens Android Studio → Run
npm run open:ios      # opens Xcode → Run
```

`www/` is generated from the root `index.html` and is not committed. Re-run
`npm run sync` after **every** edit to `index.html`, or the native app will keep
running the previous copy.

The `android/` and `ios/` projects **are** committed, because both carry
hand-made changes that `cap add` does not generate (below). Don't delete and
re-add a platform without re-applying them.

---

## Platform changes that are not auto-generated

### Android

- `AndroidManifest.xml` — `usesCleartextTraffic="true"` plus a
  `network_security_config.xml`. Without this Android blocks *all* plain-HTTP
  traffic from API 28 onward and every device request fails before leaving the
  phone.
- `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `CHANGE_NETWORK_STATE`
  permissions, for the plugin below.
- `WifiBindPlugin.java` — calls `bindProcessToNetwork()` so this app's sockets
  use Wi-Fi. Android keeps mobile data as the *default* network when the joined
  Wi-Fi has no internet uplink, which is exactly the Gauge.S case, so without
  this a request to `192.168.4.1` can be handed to the cellular interface and
  fail. The network request deliberately drops `NET_CAPABILITY_INTERNET` —
  otherwise it would never match an access point with no uplink.
  Registered in `MainActivity.onCreate` *before* `super.onCreate()`.

### iOS

- `Info.plist` — `NSAppTransportSecurity` with `NSAllowsArbitraryLoads` and
  `NSAllowsLocalNetworking` (ATS blocks cleartext by default), and
  `NSLocalNetworkUsageDescription`, which iOS 14+ requires before an app may
  talk to devices on the local network. iOS shows a permission prompt on the
  first device request — it must be accepted or nothing will connect.

---

## How deleting works now

Forks of the ESP FSBrowser `/edit` handler disagree about how the `path`
argument is parsed. Natively there is no preflight in the way, so the app tries
each variant in turn until one is accepted, then remembers the winner in
`localStorage` so later deletes go straight to it:

1. `DELETE /edit` with a `multipart/form-data` body — what the device's own
   editor UI sends
2. `DELETE /edit` with an `application/x-www-form-urlencoded` body
3. `DELETE /edit?path=…` with no body

The Activity Log names the variant that worked. If all three are refused, the
device itself is rejecting the request (nothing on the phone blocked it) and the
log shows what each variant returned.

The multipart body is assembled by hand rather than with `FormData` because the
native layer only accepts string/JSON bodies.

---

## Where merged files go

`Documents/GaugeS/` when writable, otherwise app storage, otherwise the app
cache — scoped storage can refuse `Documents` on newer Android. The log line
says which was used, and an **Export** button offers the results to the system
share sheet.

---

## Troubleshooting

| Problem | Cause / fix |
|---|---|
| "could not reach the device" on every request | Phone dropped the Gauge.S Wi-Fi. On Android also check the green banner — if Wi-Fi pinning is unavailable, turn mobile data off. |
| iOS never connects | The local-network permission prompt was declined. Settings → the app → Local Network. |
| Deletes fail with all three variants listed | The firmware is refusing the request. The response body for each attempt is in the log — that is a device-side answer, not a phone-side block. |
| Native app still shows old UI | `npm run sync` was not re-run after editing `index.html`. |
