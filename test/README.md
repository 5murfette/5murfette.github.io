# Burrow Brawl

Turn-based artillery with 28 weapons/tools, destructible terrain, live physical props, CPU opponents, local hotseat and online friend matches.

## Play

Open **`index.html`** or **`burrow-brawl.html`**. Keep the HTML, `assets`, `vendor`, and supporting files together. The renderer, post-processing, artwork and fonts are included locally, so direct-file play works offline too.

## Choose starting positions

In setup, **Worm placement** offers:

- **Random** — the default, with the existing automatic starting positions.
- **User** — teams take turns placing **one worm each per round**, in setup order. Every worm gets **15 real seconds**, independent of frame rate and explosion slow motion. Local pause pauses that countdown.

Click/tap clear space above the water to place the current worm. A shallow click into the ground lifts its feet clear; deep terrain and overlapping worms are invalid. You can also use **arrow keys + Enter/Space**, or **Auto-place this worm**. Right-drag/two-finger drag pans; the wheel/pinch zooms. A touch drag, pinch or cancelled touch does not place a worm.

CPU teams choose their own positions during their turns. Timeouts use automatic placement, preferring separation from other worms and avoiding nearby mines/barrels when suitable ledges exist.

Each worm arrives in a teleport beam. **Its physics and vulnerability begin immediately:** mines trigger, fuses run, explosives chain, terrain breaks, and gravity/damage apply during deployment. Reserve worms have no physical presence until placed. After the final placement, the battlefield settles and ordinary combat starts. In friend matches, the host runs this simulation and validates the friend's placement requests.

## Install for offline play

Host the **entire `PoC` directory on HTTPS**, keeping relative paths intact, then open it in the browser. A static host is sufficient; no game server or build step is needed for local play.

1. Click the **Install** button on the right edge.
2. Wait for **Offline ready**. The complete runtime download is approximately **3 MB**.
3. Chrome/Edge: use **Install game** when offered, or the browser's install/address-bar option.
4. iPhone/iPad: open in Safari, choose **Share → Add to Home Screen**, and enable **Open as Web App** if shown.
5. Supported macOS Safari: choose **File → Add to Dock**.

For Apple launchers, open the new icon once while online and check **Offline ready**, since the installed app may have its own storage. CPU and same-device multiplayer then work offline. Online friend matches use internet signalling and peer connectivity.

The icon is original GPT Image 2.5 Flare artwork. Standard, Apple touch and Android maskable sizes are included under `assets/app/`.

### Local installation test

From this directory:

```sh
python3 -m http.server 8000
```

Open **http://localhost:8000/** on the same computer. Browsers allow service workers on localhost; mobile installation from another device needs an **HTTPS URL**, rather than an ordinary HTTP LAN address. A `file://` launch can play the local files, but cannot register an installable PWA.

### Offline downloads and updates

- The service worker precaches all 18 runtime files, including artwork/font bundles and the complete rendering dependency bundle.
- An incomplete first download is rejected and never marked ready. The install panel provides **Retry download**, including repair after cached files are missing.
- Updates download in the background and activate after all existing game windows close, avoiding a forced reload during a match.
- Clearing site/app data removes the downloaded content; reconnect and wait for **Offline ready** to download it again.

## Maintain the bundle

No build is needed to play. To regenerate dependency bundles:

```sh
npm --prefix tools install
npm --prefix tools run build
```

After changing **any runtime HTML, script, stylesheet, manifest, icon, artwork or service worker**, regenerate the versioned cache list:

```sh
node tools/build-offline.cjs --cache-only
```

Upload the changed files and `offline-assets.js` together. Serve actual JS/CSS files with their proper content types; missing assets should return an error rather than an HTML fallback.

To regenerate app icon sizes after editing `assets/app/icon-source.png`, run `python3 tools/prepare-app-icon.py` in a Python environment with Pillow, then regenerate the cache list. Third-party notices are in `vendor/`.

## Verification

`tests/placement-offline.cjs` is an optional Playwright/Chromium integration check. Point `PLAYWRIGHT_MODULE` to an existing Playwright package, or install Playwright where Node can resolve it:

```sh
PLAYWRIGHT_MODULE="/absolute/path/to/node_modules/playwright" node tests/placement-offline.cjs
```

Set `CHECK_OUTPUT` to an existing directory to save screenshots. `CHECK_PWA_ONLY=1` runs just the offline/install checks.

Verified in headless Chromium with software WebGL:

- Random default; human/CPU round-robin placement; 15-second timeout; reserve immunity; live mine damage; combat handoff.
- Real mouse, keyboard and emulated touch input; pinch/cancellation handling.
- Two-browser friend request/snapshot path, including stale/out-of-turn/duplicate rejection.
- Chromium manifest/installability validation; native-prompt button wiring.
- Fresh offline page launch and battle startup, complete artwork, direct-file offline boot, no external HTTP dependencies.
- Interrupted downloads, missing-cache repair and updates waiting for an open match to close.

The automated checks validate browser installation prerequisites and UI; physical iOS/Android home-screen installation and desktop OS launcher behaviour still need device testing.
