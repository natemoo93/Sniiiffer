/* Sniiiffer — shared post-detection logic: picking the best result, merging
   per-frame scans, building page-aware content states, and preparing the
   highlight-overlay config. Used by BOTH the popup and the background
   service worker (the configurable toolbar-click actions do everything the
   popup buttons do, so the logic can't live in popup.js alone).
   Loads after common/detect.js. No chrome.* and no DOM — callers own
   storage and UI; this file owns fetch()-based manifest work. */

/* Single-result policy: rank every detection, show/act on only the winner.
   Platform handlers outrank scraped links for the same reason whatiiif
   checks PLATFORMS before running heuristics — they're hand-verified
   against the institution, and page markup can point at wrappers the
   viewer can't render (e.g. DPUL pages link the sc:Collection while the
   platform handler returns the renderable volume manifest). */
function tierOf(r) {
  if (r.confidence === 'confirmed') return 0;
  if (r.needsResolve) return 1;
  if (r.source && r.source.indexOf('platform:') === 0) return 1;
  if (r.confidence === 'likely') return 2;
  if (r.resolveFailed || r.checked) return 4;
  return 3;
}
function pickBest(results) {
  let best = null, bestTier = 9;
  (results || []).forEach(function (r) {
    const t = tierOf(r);
    if (t < bestTier) { best = r; bestTier = t; }
  });
  return best;
}

// A stored per-tab session entry ({frames: {frameId: {pageUrl, results,
// hint}}}) → frame list ordered top-frame first, ready for mergeFrameEntries
function entryFrameList(entry) {
  if (!entry || !entry.frames) return [];
  const keys = Object.keys(entry.frames).sort(function (a, b) { return (a === '0' ? -1 : b === '0' ? 1 : 0); });
  return keys.map(function (k) {
    const f = entry.frames[k];
    return { url: f.pageUrl, results: f.results, hint: f.hint };
  });
}

// Merge per-frame scans (top frame first): dedupe results across frames,
// take the first non-null page hint — embedded UV viewers carry the live
// #?cv= (and volume m=) in their iframe URL, not the tab URL
function mergeFrameEntries(frameEntries) {
  const agg = [];
  let hint = null;
  (frameEntries || []).forEach(function (fe) {
    if (!fe) return;
    if (!hint && fe.hint) hint = fe.hint;
    (fe.results || []).forEach(function (r) { agg.push(r); });
  });
  const seen = {};
  const results = agg.filter(function (r) {
    const k = r.url || ('resolve:' + r.platform);
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });
  return { results: results, hint: hint };
}

// Resolve an async-platform best result (Figgy, LibraryCloud, LoC ?fo=json…)
// into a concrete manifest URL, or a resolveFailed marker on failure
async function resolveAsyncBest(best, pageUrl) {
  const p = PLATFORMS.filter(function (pl) { return pl.name === best.platform && pl.async; })[0];
  let resolved = null;
  try { resolved = p && await p.resolve(best.pageUrl || pageUrl); } catch (e) {}
  return resolved
    ? { url: resolved, source: 'platform:' + best.platform, confidence: 'likely' }
    : { platform: best.platform, source: 'platform', confidence: 'candidate', resolveFailed: true };
}

/* Page-aware content state with collection safety: fetch the manifest once.
   Collections pick the volume the viewer was showing (UV m=, else volume 1)
   and target the canvas inside it. A volume index >0 against a plain
   manifest means the viewer was on a different volume than this manifest —
   a wrong-page target is worse than none, so that case gets a
   manifest-level token. Falls back to a manifest-level token whenever a
   fetch fails. */
async function canvasTokenFor(manifestUrl, index) {
  try {
    const r = await fetch(manifestUrl, { signal: AbortSignal.timeout(25000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (!looksLikeManifest(j)) return null;
    const cvs = getCanvases(j);
    const cid = index < cvs.length ? canvasIdOf(cvs[index]) : null;
    return cid ? { token: buildCanvasContentState(manifestUrl, cid), url: manifestUrl, page: index + 1, complete: true } : null;
  } catch (e) { return null; }
}

/* complete:false marks a fallback caused by a failed fetch — the result is
   usable but retryable; complete:true results are final (either page-aware,
   or manifest-level because there was genuinely no page to target). */
async function contentStateFor(manifestUrl, hint) {
  try {
    const rs = await fetch(manifestUrl, { signal: AbortSignal.timeout(25000) });
    if (rs.ok) {
      const mj = await rs.json();
      if (looksLikeManifest(mj)) {
        const vols = collectionManifests(mj);
        if (vols.length) {
          const volUrl = (hint && hint.manifestIndex && vols[hint.manifestIndex]) || vols[0];
          if (hint) {
            const cs = await canvasTokenFor(volUrl, hint.index);
            if (cs) return cs;
          }
          return { token: buildManifestContentState(volUrl), url: volUrl, page: null, complete: !hint };
        }
        if (hint && !hint.manifestIndex) {
          const canvases = getCanvases(mj);
          const cid = hint.index < canvases.length ? canvasIdOf(canvases[hint.index]) : null;
          if (cid) return { token: buildCanvasContentState(manifestUrl, cid), url: manifestUrl, page: hint.index + 1, complete: true };
        }
        return { token: buildManifestContentState(manifestUrl), url: manifestUrl, page: null, complete: true };
      }
    }
  } catch (e) {}
  return { token: buildManifestContentState(manifestUrl), url: manifestUrl, page: null, complete: false };
}

/* Everything the in-page highlight overlay needs, resolved HERE so the
   overlay itself never touches the manifest: effective manifest URL
   (collections unwrap to the viewed volume — same policy as
   contentStateFor), the canvas being viewed, its display-image candidates,
   and the full-pixel dimensions the xywh coordinates are expressed in. */
async function highlightConfigFor(manifestUrl, hint) {
  const fetchManifestJson = async function (u) {
    const r = await fetch(u, { signal: AbortSignal.timeout(25000) });
    if (!r.ok) return null;
    const j = await r.json();
    return looksLikeManifest(j) ? j : null;
  };
  let url = manifestUrl;
  let mj = await fetchManifestJson(url);
  if (!mj) return null;
  const vols = collectionManifests(mj);
  if (vols.length) {
    url = (hint && hint.manifestIndex && vols[hint.manifestIndex]) || vols[0];
    mj = await fetchManifestJson(url);
    if (!mj) return null;
  }
  const canvases = getCanvases(mj);
  if (!canvases.length) return null;
  // same volume-mismatch rule as contentStateFor: a hint carrying a volume
  // index against a plain manifest belongs to a different volume — page 1
  const useHint = hint && (vols.length > 0 || !hint.manifestIndex);
  const idx = (useHint && hint.index >= 0 && hint.index < canvases.length) ? hint.index : 0;
  const canvas = canvases[idx];
  const canvasId = canvasIdOf(canvas);
  const imageUrls = canvasImageUrls(canvas);
  if (!canvasId || !imageUrls.length) return null;
  const dims = getCanvasDimensions(canvas);
  return {
    manifestUrl: url,
    canvasId: canvasId,
    canvasIndex: idx,
    page: idx + 1,
    imageUrls: imageUrls,
    cW: dims.cW,
    cH: dims.cH,
    svcBase: getServiceBase(canvas) || null
  };
}

/* ── Node export for tests (ignored in extension contexts) ── */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    tierOf: tierOf,
    pickBest: pickBest,
    entryFrameList: entryFrameList,
    mergeFrameEntries: mergeFrameEntries,
    resolveAsyncBest: resolveAsyncBest,
    canvasTokenFor: canvasTokenFor,
    contentStateFor: contentStateFor,
    highlightConfigFor: highlightConfigFor
  };
}
