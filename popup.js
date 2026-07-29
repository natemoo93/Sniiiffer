/* Sniiiffer popup — shows THE most likely manifest for the active tab (a
   list of alternatives reads as guessing), with Copy URL / Open in whatiiif /
   Highlight. Precedence mirrors whatiiif: validated result > institution
   platform handler > scraped page evidence > guesses. Async platform matches
   auto-resolve when the popup opens (a user gesture). */

(function () {
  'use strict';

  let tab = null;
  let pageUrl = '';
  let results = [];
  // Page hint from whichever frame has one — embedded UV viewers carry the
  // live #?cv= (and volume m=) in their iframe URL, not the tab URL
  let pageHint = null;

  const $ = function (id) { return document.getElementById(id); };

  const SOURCE_LABELS = {
    'this-page': 'this page is a manifest',
    'signposting-html': 'Signposting link tag',
    'signposting-header': 'Signposting Link header',
    'viewer-link': 'embedded viewer link',
    'content-state': 'IIIF Content State',
    'config-key': 'viewer config',
    'data-attribute': 'embed attribute',
    'bare-url': 'URL in page markup',
    'tind-route': 'TIND manifest route',
    'image-api-host': 'derived from Image API host',
    'suffix-guess': 'guessed URL',
    'platform': 'institution pattern'
  };

  function srcLabel(r) {
    let s;
    if (r.source && r.source.indexOf('platform:') === 0) s = r.source.slice(9);
    else s = SOURCE_LABELS[r.source] || r.source || '';
    if (r.collection) s += ' — volume 1 of a collection';
    return s;
  }

  /* Ranking (pickBest) is pure and runs here. Anything that FETCHES the
     manifest — contentStateFor, highlightConfigFor — must run in the
     background worker instead: this popup is an ordinary
     chrome-extension:// document, so its fetch() is CORS-checked and
     host_permissions doesn't exempt it. Calling those helpers here worked
     only for hosts serving ACAO * (Princeton's iiif-cloud); everywhere else
     the content state silently degraded to a manifest-level token and the
     highlight config came back null. The worker's fetch is not CORS-checked. */
  function ask(type, payload) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(Object.assign({ type: type }, payload), function (res) {
        if (chrome.runtime.lastError || !res) { reject(new Error('worker unavailable')); return; }
        resolve(res);
      });
    });
  }

  /* Copy-content-state and Open-in-whatiiif MUST emit the same token — both
     await one memoized computation per manifest URL. Incomplete results
     (fetch failure) aren't cached, so the next click retries instead of
     locking in a degraded token. Pre-warmed at render time so the first
     click doesn't wait on a manifest download. */
  const csCache = {};
  function contentStateEnsure(url) {
    if (!csCache[url]) {
      csCache[url] = ask('sniiiffer:contentState', { url: url, hint: pageHint }).then(function (cs) {
        if (!cs.complete) delete csCache[url];
        return cs;
      }, function () {
        delete csCache[url];
        return { token: buildManifestContentState(url), url: url, page: null, complete: false };
      });
    }
    return csCache[url];
  }

  /* Highlight availability is only knowable by fetching the manifest (does it
     have canvases, does the viewed one have a usable image?), so the button
     starts disabled and is enabled by this probe — kicked off at render time.
     One probe per manifest URL; a null cfg is a real "not available here",
     not a transient, because the worker already swallowed fetch errors. */
  const hlCache = {};
  function highlightEnsure(url) {
    if (!hlCache[url]) {
      hlCache[url] = ask('sniiiffer:highlightConfig', { url: url, hint: pageHint })
        .then(function (res) { return res.cfg; }, function () { return null; });
    }
    return hlCache[url];
  }

  function render() {
    const list = $('list');
    list.innerHTML = '';
    const r = pickBest(results);
    $('empty').hidden = !!r;
    $('count').textContent = '';
    if (!r) return;

    const div = document.createElement('div');
    div.className = 'item ' + (r.confidence || '');

    const row1 = document.createElement('div');
    row1.className = 'row1';
    const chip = document.createElement('span');
    chip.className = 'chip ' + (r.confidence || 'candidate');
    chip.textContent = r.confidence === 'confirmed' ? 'manifest' :
                       r.confidence === 'likely' ? 'likely' :
                       r.needsResolve ? 'platform' : 'unverified';
    row1.appendChild(chip);
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = r.needsResolve ? (r.platform + ' — resolving…') :
                      r.resolveFailed ? (r.platform + ' — could not resolve') : srcLabel(r);
    row1.appendChild(src);
    div.appendChild(row1);

    if (r.url) {
      const u = document.createElement('div');
      u.className = 'url';
      u.textContent = r.url;
      u.title = r.url;
      div.appendChild(u);
    }
    if (r.label) {
      const l = document.createElement('div');
      l.className = 'src';
      l.textContent = r.label;
      div.appendChild(l);
    }

    if (r.url) {
      const btns = document.createElement('div');
      btns.className = 'btns';
      const copyBtn = function (label, getPayload) {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', async function () {
          b.disabled = true;
          let payload = null;
          try { payload = await getPayload(); } catch (e) {}
          b.disabled = false;
          if (!payload) return;
          navigator.clipboard.writeText(payload.text).then(function () {
            b.textContent = payload.feedback || 'Copied';
            setTimeout(function () { b.textContent = label; }, 1500);
          });
        });
        btns.appendChild(b);
      };
      copyBtn('Copy URL', function () { return { text: r.url }; });
      /* No "Copy content state" button here by design: the token it produced
         was only page-accurate when the viewer exposed a page number in its
         URL, so on JS-state viewers it silently degraded to a whole-manifest
         token. The highlight overlay's page field covers the same need
         without that inconsistency — it emits a content state for a page the
         user has actually confirmed. contentStateEnsure stays because
         "Open in whatiiif" still uses the token as its ?iiif-content=. */
      const open = document.createElement('button');
      open.textContent = 'Open in whatiiif';
      open.addEventListener('click', async function () {
        open.disabled = true;
        let cs = null;
        try { cs = await contentStateEnsure(r.url); } catch (e) {}
        open.disabled = false;
        const dest = cs
          ? WHATIIIF_BASE + '/?iiif-content=' + encodeURIComponent(cs.token)
          : WHATIIIF_BASE + '/?manifest=' + encodeURIComponent(r.url);
        chrome.tabs.create({ url: dest });
      });
      btns.appendChild(open);
      // Highlight a region: draw a box on the page image, in an overlay
      // injected into the tab (the popup is 380px wide and closes on blur —
      // no room to draw here). Only on injectable pages.
      if (/^https?:/i.test(pageUrl)) {
        const hl = document.createElement('button');
        hl.textContent = 'Highlight…';
        // Disabled until the probe below proves a highlight can actually be
        // built — an enabled button that silently does nothing is worse than
        // one that says why it can't.
        hl.disabled = true;
        hl.title = 'Checking whether this manifest can be highlighted…';
        highlightEnsure(r.url).then(function (cfg) {
          if (cfg) {
            hl.disabled = false;
            hl.title = 'Draw a box on page ' + cfg.page + ' and get a shareable highlight link';
          } else {
            hl.title = 'Highlighting is not available for this manifest — its page image could not be read';
          }
        });
        hl.addEventListener('click', async function () {
          hl.disabled = true;
          $('status').textContent = 'Preparing highlight…';
          let cfg = null;
          try { cfg = await highlightEnsure(r.url); } catch (e) {}
          if (!cfg) {
            $('status').textContent = 'Highlighting is not available for this manifest.';
            return;
          }
          try {
            // Top frame only: the overlay is page UI. detect.js ships WITH
            // highlight.js — an injected file gets its own top-level scope, so
            // the content script's copy isn't visible to it; detect.js
            // republishes its helpers on globalThis for highlight.js to use.
            // Re-injecting is harmless (both files are idempotent).
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['common/detect.js', 'highlight.js']
            });
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: function (c) { __sniiifferHighlight(c); },
              args: [cfg]
            });
            window.close(); // hand the page back to the user to draw
          } catch (e) {
            hl.disabled = false;
            $('status').textContent = 'Cannot draw on this page.';
          }
        });
        btns.appendChild(hl);
      }
      div.appendChild(btns);
      // pre-warm the token so "Open in whatiiif" doesn't wait on a manifest
      // download (the highlight probe self-starts above — it gates its button)
      contentStateEnsure(r.url);
    }
    list.appendChild(div);
  }

  /* If the best detection is an async platform match, resolve it now —
     opening the popup is the user gesture that authorizes the lookup.
     Runs in the worker for the same CORS reason as the helpers above: these
     resolvers fetch institution APIs (Figgy, LibraryCloud, LoC ?fo=json)
     that don't serve ACAO * to an extension origin. */
  async function ensureResolved() {
    const best = pickBest(results);
    if (!best || !best.needsResolve) return;
    render(); // shows "resolving…" state
    const idx = results.indexOf(best);
    let resolved;
    try {
      resolved = await ask('sniiiffer:resolveAsync', { best: best, pageUrl: pageUrl });
    } catch (e) {
      resolved = { platform: best.platform, source: 'platform', confidence: 'candidate', resolveFailed: true };
    }
    results[idx] = resolved;
    render();
  }

  function aggregate(frameEntries) {
    // frameEntries: [{url, results, hint}] in frame order (top frame first)
    const merged = mergeFrameEntries(frameEntries);
    results = merged.results;
    pageHint = merged.hint;
  }

  function loadFromSession() {
    if (!tab) return;
    chrome.storage.session.get('tab:' + tab.id, function (data) {
      const entry = data && data['tab:' + tab.id];
      if (entry && entry.frames) {
        aggregate(entryFrameList(entry));
        render();
        ensureResolved();
      }
    });
  }

  function init() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      tab = tabs && tabs[0];
      if (!tab) return;
      pageUrl = tab.url || '';
      // Fresh scan across ALL frames (embedded viewers included); falls back
      // to stored passive results where injection is impossible (chrome://…)
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: function () {
          try {
            return {
              url: location.href,
              results: typeof __sniiifferScan === 'function' ? __sniiifferScan() : [],
              hint: typeof extractPageHint === 'function' ? extractPageHint(location.href) : null
            };
          } catch (e) { return null; }
        }
      }, function (frames) {
        if (chrome.runtime.lastError || !frames || !frames.length) {
          $('status').textContent = 'Page not scannable — showing last results.';
          loadFromSession();
          return;
        }
        frames.sort(function (a, b) { return a.frameId - b.frameId; });
        aggregate(frames.map(function (f) { return f.result; }));
        render();
        ensureResolved();
      });
    });

    $('settings').addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
    });

    $('deepScan').addEventListener('click', function () {
      if (!tab) return;
      $('deepScan').disabled = true;
      $('status').textContent = 'Scanning…';
      chrome.runtime.sendMessage(
        { type: 'sniiiffer:deepScan', tabId: tab.id, pageUrl: pageUrl, results: results },
        function (res) {
          $('deepScan').disabled = false;
          if (chrome.runtime.lastError || !res) {
            $('status').textContent = 'Deep scan failed.';
            return;
          }
          results = res.results || results;
          $('status').textContent = 'Deep scan done (' + res.probes + ' request' + (res.probes === 1 ? '' : 's') + ').';
          render();
        }
      );
    });
  }

  init();
})();
