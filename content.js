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

  /* ── DOM page hint: Mirador and Clover ──
     Both keep the open canvas in JS state (Redux / React) with nothing in the
     URL, so extractPageHint can't see it. Neither state store is reachable
     from the isolated world either. What IS readable is what they render:
     Image API URLs in <img src> and in OSD's tile images. The service base of
     the displayed image identifies the canvas, and resolveHintIndex matches it
     against the manifest (imgServiceBase arm).

     Deliberately conservative, in the spirit of extractPageHint's URL rules:
     - Only runs when the page looks like Mirador or Clover. A generic
       "biggest IIIF image on the page" rule would fire on gallery and search
       pages, where the largest thumbnail is not an open canvas.
     - Returns null on disagreement rather than picking one. On a Mirador
       multi-window workspace, or mid-transition between pages, several
       canvases are legitimately on screen; a wrong page is worse than none. */

  // An Image API URL ends {region}/{size}/{rotation}/{quality}.{fmt} — strip
  // exactly those four to get the service base. Same anchoring as detect.js's
  // IMG_API_TAIL (kept local: this reads DOM strings, not manifest nodes).
  const DOM_IMG_API_TAIL = /^(https?:\/\/.+?)\/[^\/]+\/[^\/]+\/[^\/]+\/[^\/]+\.[a-z]+(?:[?#]|$)/i;

  function serviceBaseOfImageUrl(u) {
    const s = String(u || '');
    // info.json also has four trailing segments and would match the tail
    // pattern, yielding a truncated garbage base. It never matches a real
    // canvas, but it counts as a distinct base and would suppress an
    // otherwise-good hint in domPageHint's single-canvas check.
    if (/\/info\.json([?#]|$)/i.test(s)) return null;
    const m = s.match(DOM_IMG_API_TAIL);
    return m ? m[1].replace(/\/+$/, '') : null;
  }

  // Mirador renders into OSD canvases but keeps <img> tiles in the DOM; Clover
  // (also OSD-based) does the same. Both also emit thumbnail strips, which are
  // Image API URLs for OTHER canvases — those must not be read as the open
  // page, so thumbnail containers are excluded by selector.
  function isMiradorOrClover() {
    if (document.querySelector('[class*="mirador" i], #mirador, [data-mirador], .mirador-viewer')) return true;
    if (document.querySelector('[class*="clover" i], [data-clover], #clover-iiif, .clover-viewer')) return true;
    return false;
  }

  function domPageHint() {
    try {
      if (!isMiradorOrClover()) return null;
      // Exclude thumbnail/navigation regions: their images are other canvases.
      const EXCLUDE = '[class*="thumb" i],[class*="Thumb"],[class*="gallery" i],' +
                      '[class*="nav" i],[class*="filmstrip" i],[class*="strip" i],' +
                      '[role="navigation"],[class*="sidebar" i]';
      const bases = {};
      const imgs = document.querySelectorAll('img[src*="/full/"], img[src*="/default."], canvas + img, .openseadragon-canvas img');
      for (let i = 0; i < imgs.length; i++) {
        const el = imgs[i];
        if (el.closest && el.closest(EXCLUDE)) continue;
        // Skip tiny images: OSD keeps low-res placeholder tiles around, but so
        // do thumbnails that dodged the selector filter above.
        const w = el.naturalWidth || el.width || 0;
        if (w && w < 200) continue;
        const b = serviceBaseOfImageUrl(el.currentSrc || el.src);
        if (b) bases[b] = (bases[b] || 0) + 1;
      }
      const keys = Object.keys(bases);
      // Exactly one distinct canvas on screen, or nothing usable.
      if (keys.length !== 1) return null;
      return { imgServiceBase: keys[0] };
    } catch (e) { return null; }
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
        // carries the live #?cv= the top page never sees. URL hints win over
        // the DOM read: a URL convention is an explicit page position, while
        // the DOM hint is inferred from what happens to be rendered.
        hint: extractPageHint(location.href) || domPageHint()
      });
    } catch (e) {} // extension reloaded/disabled — nothing to do
    return results;
  }

  // The popup collects fresh per-frame scans via chrome.scripting.executeScript
  // (allFrames) calling this — a plain onMessage responder can't aggregate
  // across frames (only the first frame's response would win).
  globalThis.__sniiifferScan = passiveScan;
  // The popup's fresh rescan needs the hint too, and the DOM arm of it lives
  // here rather than in detect.js (which is DOM-free by contract). Without
  // this the popup would fall back to extractPageHint alone and lose the
  // Mirador/Clover hint — which is exactly the case that changes most often,
  // since the user can page the viewer between the passive scan and the click.
  globalThis.__sniiifferHint = function () {
    try { return extractPageHint(location.href) || domPageHint(); } catch (e) { return null; }
  };

  // Initial scan, plus one delayed rescan for SPAs that render after idle.
  // No MutationObserver: a persistent observer on every page costs more than
  // the popup-open rescan buys.
  report();
  setTimeout(report, 3000);
})();
