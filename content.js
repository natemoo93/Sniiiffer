/* Sniiiffer content script — passive detection only.
   Runs on every page but makes ZERO network requests: it reads the page URL
   and the rendered DOM, nothing else. Anything that needs the network
   (validation, async platform resolution, Link-header Signposting, suffix
   guesses) happens in the background service worker, and only when the user
   asks (deep scan from the popup).
   Loads after common/detect.js (see manifest.json content_scripts order). */

(function () {
  'use strict';

  function passiveScan() {
    const results = [];
    const pageUrl = location.href;

    // 1. The page itself is a manifest (user navigated straight to JSON —
    //    Chrome renders it inside a <pre>, so parse the body text)
    if (/json/i.test(document.contentType || '')) {
      try {
        const data = JSON.parse(document.body ? document.body.textContent : '');
        if (looksLikeManifest(data)) {
          results.push({ url: pageUrl, source: 'this-page', confidence: 'confirmed' });
        }
      } catch (e) {}
    }

    // 2. Content state in the page URL itself
    const csm = pageUrl.match(/[?&#]iiif-content=([^&#\s]+)/);
    if (csm) {
      let tok = csm[1];
      try { tok = decodeURIComponent(tok); } catch (e) {}
      const cs = parseContentState(tok);
      if (cs && cs.manifestId) results.push({ url: cs.manifestId, source: 'content-state', confidence: 'likely' });
    }

    // 3. Platform detection on the page URL
    const p = detectPlatform(pageUrl);
    if (p && p.name !== 'Direct manifest URL') { // direct-manifest case is covered by #1
      if (p.async) {
        results.push({ platform: p.name, pageUrl: pageUrl, source: 'platform', confidence: 'platform', needsResolve: true });
      } else {
        const m = p.resolve(pageUrl);
        if (m) results.push({ url: m, source: 'platform:' + p.name, confidence: 'likely' });
      }
    }

    // 4. Page-scan heuristics on the rendered DOM (catches SPA-injected state
    //    that the static HTML — and therefore whatiiif's proxy read — misses)
    let html = '';
    try { html = document.documentElement.outerHTML || ''; } catch (e) {}
    if (html) {
      scanHtml(html, document.baseURI || pageUrl).forEach(function (c) {
        const likely = c.source === 'signposting-html' || c.source === 'viewer-link' || c.source === 'content-state';
        results.push({ url: c.url, source: c.source, confidence: likely ? 'likely' : 'candidate' });
      });
    }

    // Dedupe by url, keeping the strongest mention (insertion order is
    // strongest-first within each tier; confirmed entries were pushed first)
    const seen = {};
    return results.filter(function (r) {
      const key = r.url || ('resolve:' + r.platform);
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function report() {
    let results = [];
    try { results = passiveScan(); } catch (e) { results = []; }
    try {
      chrome.runtime.sendMessage({
        type: 'sniiiffer:found',
        pageUrl: location.href,
        results: results,
        // this frame's page hint — in an embedded UV iframe, location.href
        // carries the live #?cv= the top page never sees
        hint: extractPageHint(location.href)
      });
    } catch (e) {} // extension reloaded/disabled — nothing to do
    return results;
  }

  // The popup collects fresh per-frame scans via chrome.scripting.executeScript
  // (allFrames) calling this — a plain onMessage responder can't aggregate
  // across frames (only the first frame's response would win).
  globalThis.__sniiifferScan = passiveScan;

  // Initial scan, plus one delayed rescan for SPAs that render after idle.
  // No MutationObserver: a persistent observer on every page costs more than
  // the popup-open rescan buys.
  report();
  setTimeout(report, 3000);
})();
