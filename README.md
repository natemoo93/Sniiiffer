# Sniiiffer

A browser extension that sniffs out IIIF manifests on the pages you visit. When one is detected, the toolbar dog icon (a mastiiiff) shows a badge, and upon clicking the the user can copy the manifest URL, open it in [whatiiif](https://whatiiif.com), or highlight a region and generate a link/content state token right there on the page.


## Highlighting a region

**Highlight…** in the popup overlays the item manifest you're viewing with the canvas image of the page you were viewing when page awareness is supported. A **page field** in the toolbar shows which canvas is loaded and lets you correct it by entering the number or navigate forward/back. Page detection isn't always possible, so the overlay sometimes opens on page 1. A manually chosen page is indistinguishable from a detected one, since the canvas id, image, coordinate space and both share links are all rebuilt from it. 

Drawing happens on Sniiiffer's own copy of the image, not over the host page's viewer. If the site blocks the image from loading in the overlay, a one-click "Highlight in whatiiif instead" fallback opens the same page there.

## Settings: what a click does

By default a single click on the toolbar icon opens the results panel. In the extension's options (⚙ in the panel footer, or right-click the icon → Options) you can bind the click directly to one action instead: **copy the manifest URL**, **open in whatiiif**, or **highlight a region**. 

## Install (developer mode)

1. Chrome/Edge → `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → select this `Sniiiffer/` folder

Firefox note: the manifest carries both `background.service_worker` (Chrome) and `background.scripts` (Firefox) keys, but the extension is primarily developed and tested against Chrome/Edge.

## Politeness design

Carried over from whatiiif's heuristic resolver, deliberately:

- Passive detection sends **no requests at all**: it only reads the page already in front of the user.
- All network activity requires a user gesture (opening the popup / clicking Deep scan) and is capped at 8 probes (`SNIIIFFER_PROBE_CAP`), stopping at the first validated manifest.
- Probes are single user-initiated GETs from the user's own browser IP with the browser's own User-Agent: no spoofing, no proxying, no retry loops. A burst of guessed-URL 404s is scanner-shaped traffic; the cap and stop-early rule keep us out of that shape.
- Failed suffix guesses are dropped from the results rather than shown; they were guesses, not evidence.

## Code layout

- `common/detect.js`: all detection logic, pure (no `chrome.*`, no DOM). Loaded by the content script, the service worker (`importScripts`), and Node tests.
- `common/actions.js`: post-detection logic shared by the popup and the background worker: best-result ranking, frame merging, page-aware content states, highlight config. (Not a content script.)
- `content.js`: passive scan, reports to background.
- `background.js`: badge management, deep scan, and the configurable toolbar-click actions.
- `popup.html` / `popup.js`: results UI (Copy URL / Open in whatiiif / Highlight / Deep scan).
- `options.html` / `options.js`: the single-click behavior setting (`chrome.storage.sync`).
- `highlight.js`: the region-drawing overlay, injected into the tab on demand (popup button or direct click action), always together with `common/detect.js`. An injected file gets its own top-level scope even in the isolated world the content script already occupies, so it cannot see that copy; detect.js publishes the three helpers the overlay needs (`buildCanvasContentState`, `buildWhatiiifHighlightUrl`, `WHATIIIF_BASE`) on `globalThis` for it, and the overlay throws up front if they're missing.
