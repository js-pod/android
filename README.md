# Solid Pod for Android

An **installable Android app** that runs a full [Solid pod](https://solidproject.org/) on your phone. Same pod that `npx jspod` boots on a laptop — wrapped in a [React Native](https://reactnative.dev/) shell so it lives on your home screen and survives backgrounding.

> Status: **experimental scaffold**. The intent is to produce a sideloadable `.apk` from CI on every push.

## Architecture

```
┌─────────────────────────────────────────────┐
│  React Native UI (App.tsx)                  │
│  • status screen                            │
│  • "Open in browser" button                 │
└──────────────┬──────────────────────────────┘
               │  IPC channel
               ▼
┌─────────────────────────────────────────────┐
│  nodejs-mobile (embedded Node.js runtime)   │
│  • runs nodejs-assets/nodejs-project/main.js│
│  • starts jspod → JSS                       │
│  • auto-installs default bundle on first run│
└─────────────────────────────────────────────┘
                │
                ▼
        http://localhost:5444/
        opens in system browser
```

Two important pieces:

- **`nodejs-mobile-react-native`** embeds a real Node.js runtime inside the APK. JSS is pure JavaScript (no native modules) so it runs as-is. The embedded Node lives in `nodejs-assets/nodejs-project/`.
- **`PodForegroundService.kt`** keeps the Node process alive when the app is backgrounded. Without this, Android would kill the pod the moment you swipe away.

## Build

You need: JDK 17, Node 20+, Android SDK (API 35) + NDK 26.

```bash
# 1. RN deps
npm install

# 2. Node-side deps (jspod and its tree)
npm run prepare-node-assets

# 3. Build debug APK
cd android
./gradlew assembleDebug

# APK lands at:
# android/app/build/outputs/apk/debug/app-debug.apk
```

Or trigger the **build-apk** workflow (Actions tab → Run workflow). It builds a
release APK, attaches it to the rolling **[`latest` release](../../releases/latest)**,
and also uploads a short-lived CI artifact.

## Install on your phone

**[⬇ Download the latest APK](https://github.com/js-pod/android/releases/latest/download/solid-pod.apk)**

1. Open that link on your phone (or transfer the file over).
2. Open the APK — allow "install from this source" when prompted (it's debug-signed for sideloading, not from the Play Store).
3. Launch **Solid Pod** from your app drawer.
4. Tap "Open in browser" when the status flips to running.
5. Sign in as `me` / `me` (localhost-only — change once you've decided what you want).

The download link is permanent and always points at the most recent build. Updates install over the top (the app is signed with a stable key), so your pod data is preserved.

## What you get

The pod auto-installs [the default bundle](https://github.com/solid-apps/bundles/blob/gh-pages/default.jsonld) on first run: home, store, plaza, vellum, plume, chat, timeline, charlie, chrome, explorer, git. Each one is a real PWA — long-press the browser address bar → "Add to home screen" to pin individual apps.

## Known rough edges

- **First boot is slow** — node_modules extract from APK assets to internal storage on first launch (~5-10s on modern phones). Subsequent starts are fast.
- **System browser opens to a separate task** — by design. We'd rather not maintain a WebView with its own quirks around OIDC and service workers.
- **Pod stops if the foreground service is killed** — modern Android sometimes kills foreground services under aggressive battery savers. If the pod disappears, reopen the app.
- **No HTTPS** — the pod listens on `http://localhost`. Fine for local apps; not reachable from other devices.

## Roadmap

- [ ] Tunneling option (Tailscale / Ngrok / `solid.social` companion) so the pod is reachable off-device
- [ ] Settings screen (port, password, bundle selection, dark/light)
- [ ] iOS port (same RN code, separate Xcode project)
- [ ] F-Droid packaging
- [ ] Notification action to stop the pod cleanly

## License

AGPL-3.0-only — matches [jspod](https://github.com/JavaScriptSolidServer/jspod) and JSS.
