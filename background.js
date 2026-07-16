/* Sniiiffer background service worker.
   - Receives passive-scan reports from content scripts → sets the per-tab
     badge (the "polite notification": no popups, no system notifications).
   - Runs deep scans on request from the popup: async platform resolvers,
     Link-header Signposting (the heuristic whatiiif's Worker can't do — the
     proxy drops the Link header; the extension reads it natively), suffix
     guesses, and validation of every candidate. Network happens HERE only,
     and only on a user gesture, capped at SNIIIFFER_PROBE_CAP probes. */

importScripts('common/detect.js', 'common/actions.js');

const BADGE_COLOR_FOUND = '#7a3b1e';     // whatiiif accent
const BADGE_COLOR_CANDIDATE = '#8a8480'; // whatiiif ink-faint

// The popup shows a single best result, so the badge is a presence signal,
// not a count: ✓ = manifest detected, ? = weak evidence only.
function badgeFor(results) {
  const strong = results.some(function (r) { return r.confidence === 'confirmed' || r.confidence === 'likely' || r.needsResolve; });
  const weak = results.length > 0;
  if (strong) return { text: '✓', color: BADGE_COLOR_FOUND, title: 'Sniiiffer — IIIF manifest detected' };
  if (weak) return { text: '?', color: BADGE_COLOR_CANDIDATE, title: 'Sniiiffer — possible IIIF manifest (unverified)' };
  return { text: '', color: BADGE_COLOR_CANDIDATE, title: 'Sniiiffer — no IIIF manifest detected' };
}

/* Content scripts run in every frame (embedded viewers live in iframes and
   carry the page number in THEIR url). Reports are merged per tab, keyed by
   frame: a top-frame (frameId 0) report means a new page — reset; iframe and
   deep-scan reports accumulate. Badge reflects the union. */
function applyBadge(tabId, entry) {
  const union = [];
  Object.keys((entry && entry.frames) || {}).forEach(function (fid) {
    (entry.frames[fid].results || []).forEach(function (r) { union.push(r); });
  });
  const b = badgeFor(union);
  chrome.action.setBadgeText({ tabId: tabId, text: b.text });
  chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: b.color });
  chrome.action.setTitle({ tabId: tabId, title: b.title });
}

function updateTab(tabId, frameKey, pageUrl, results, hint) {
  const key = 'tab:' + tabId;
  chrome.storage.session.get(key, function (data) {
    let entry = data && data[key];
    if (!entry || !entry.frames || String(frameKey) === '0') entry = { frames: {} };
    entry.frames[frameKey] = { pageUrl: pageUrl, results: results || [], hint: hint || null };
    entry.at = Date.now();
    applyBadge(tabId, entry);
    const rec = {};
    rec[key] = entry;
    chrome.storage.session.set(rec);
  });
}

// Momentary badge feedback for direct-click actions (the quiet alternative
// to notifications), then restore the tab's detection badge
function flashBadge(tabId, text, title) {
  chrome.action.setBadgeText({ tabId: tabId, text: text });
  if (title) chrome.action.setTitle({ tabId: tabId, title: title });
  setTimeout(function () {
    chrome.storage.session.get('tab:' + tabId, function (d) {
      applyBadge(tabId, (d && d['tab:' + tabId]) || null);
    });
  }, 1600);
}

chrome.tabs.onRemoved.addListener(function (tabId) {
  chrome.storage.session.remove('tab:' + tabId);
});

/* ── deep scan ── */

async function fetchManifestCandidate(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const data = await r.json();
    return looksLikeManifest(data) ? data : null;
  } catch (e) { return null; }
}

// HEAD first; some servers 405 it, then one GET (headers only are read)
async function fetchLinkHeader(pageUrl) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const r = await fetch(pageUrl, { method: method, signal: AbortSignal.timeout(12000) });
      const link = r.headers.get('link');
      if (link) return link;
      if (r.ok) return null; // reachable but no Link header — don't refetch
    } catch (e) {}
  }
  return null;
}

async function deepScan(pageUrl, results) {
  const out = results.slice();
  let probes = 0;
  const canProbe = function () { return probes < SNIIIFFER_PROBE_CAP; };

  // 1. Async platform resolution (Figgy, LibraryCloud, LoC ?fo=json, page
  //    scrapes — each is one or two requests to the institution's own APIs)
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    if (!r.needsResolve || !canProbe()) continue;
    probes++;
    out[i] = await resolveAsyncBest(r, pageUrl);
  }

  // 2. Link-header Signposting on the page URL
  if (canProbe()) {
    probes++;
    const link = await fetchLinkHeader(pageUrl);
    const signposted = parseSignpostingManifest(link);
    if (signposted) {
      const abs = resolveCandidateUrl(signposted, pageUrl);
      if (abs && !out.some(function (r) { return r.url === abs; })) {
        out.unshift({ url: abs, source: 'signposting-header', confidence: 'likely' });
      }
    }
  }

  // 3. Suffix guesses (skip any URL already listed)
  suffixGuesses(pageUrl).forEach(function (g) {
    if (!out.some(function (r) { return r.url === g.url; })) {
      out.push({ url: g.url, source: g.source, confidence: 'candidate' });
    }
  });

  // 4. Validate in confidence order until the first confirmed manifest —
  //    same stop-early politeness as whatiiif's heuristicResolve. Everything
  //    else stays listed (copyable) at its current confidence.
  const order = out
    .map(function (r, idx) { return { r: r, idx: idx }; })
    .filter(function (x) { return x.r.url && x.r.confidence !== 'confirmed'; })
    .sort(function (a, b) {
      const rank = function (r) { return r.confidence === 'likely' ? 0 : 1; };
      return rank(a.r) - rank(b.r) || a.idx - b.idx;
    });
  let confirmedAny = out.some(function (r) { return r.confidence === 'confirmed'; });
  for (const x of order) {
    if (confirmedAny || !canProbe()) break;
    probes++;
    const data = await fetchManifestCandidate(x.r.url);
    if (data) {
      // Collections aren't renderable — swap in volume 1 (whatiiif's DPUL
      // policy), keeping the collection's label for display
      const vol = unwrapCollection(data);
      if (vol) {
        x.r.url = vol;
        x.r.collection = true;
      }
      x.r.confidence = 'confirmed';
      if (data.label) x.r.label = typeof data.label === 'string' ? data.label : JSON.stringify(data.label).slice(0, 120);
      confirmedAny = true;
    } else {
      x.r.checked = true; // probed, didn't validate — popup drops it from display
    }
  }

  // Drop suffix guesses that were probed and failed — they were never
  // evidence, just guesses, and listing dead URLs helps no one
  const cleaned = out.filter(function (r) { return !(r.source === 'suffix-guess' && r.checked); });
  return { results: cleaned, probes: probes };
}

/* ── configurable toolbar-click behavior ──
   'popup' (default) keeps popup.html bound so a click opens the panel.
   Any other value unbinds the popup, which routes clicks to
   chrome.action.onClicked below, and adds an icon context-menu item so the
   full panel (deep scan lives there) stays reachable. */

const CLICK_DEFAULT = 'popup';
const MENU_OPEN_PANEL = 'sniiiffer-open-panel';

function getClickAction() {
  return new Promise(function (resolve) {
    chrome.storage.sync.get({ clickAction: CLICK_DEFAULT }, function (d) {
      resolve((d && d.clickAction) || CLICK_DEFAULT);
    });
  });
}

async function applyClickAction() {
  const a = await getClickAction();
  chrome.action.setPopup({ popup: a === 'popup' ? 'popup.html' : '' });
  chrome.contextMenus.removeAll(function () {
    if (a !== 'popup') {
      chrome.contextMenus.create({ id: MENU_OPEN_PANEL, title: 'Open Sniiiffer panel', contexts: ['action'] });
    }
  });
}
applyClickAction(); // every worker start — setPopup state doesn't survive restarts
chrome.runtime.onInstalled.addListener(applyClickAction);
chrome.runtime.onStartup.addListener(applyClickAction);
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'sync' && changes.clickAction) applyClickAction();
});

chrome.contextMenus.onClicked.addListener(function (info) {
  if (info.menuItemId !== MENU_OPEN_PANEL) return;
  // openPopup (Chrome 127+) needs a bound popup and a user gesture (the menu
  // click). Rebind just long enough to show it — unbinding afterwards doesn't
  // close an already-open popup, it only governs future clicks.
  chrome.action.setPopup({ popup: 'popup.html' }, function () {
    Promise.resolve()
      .then(function () { return chrome.action.openPopup(); })
      .catch(function () {})
      .then(function () { setTimeout(applyClickAction, 250); });
  });
});

// Fresh per-frame scan, same collection the popup does on open (content
// scripts must already be in the tab); null when injection is impossible
function scanFrames(tabId) {
  return new Promise(function (resolve) {
    chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
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
      if (chrome.runtime.lastError || !frames || !frames.length) { resolve(null); return; }
      frames.sort(function (a, b) { return a.frameId - b.frameId; });
      resolve(frames.map(function (f) { return f.result; }));
    });
  });
}

// Clipboard writes can't happen in a service worker — inject into the tab.
// The toolbar click doesn't focus the document, so the async clipboard API
// can throw NotAllowed; the execCommand path tolerates that.
async function copyInTab(tabId, text) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: function (t) {
      return navigator.clipboard.writeText(t).catch(function () {
        const ta = document.createElement('textarea');
        ta.style.cssText = 'position:fixed;opacity:0;';
        ta.value = t;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      });
    },
    args: [text]
  });
}

async function handleClick(tab) {
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) return;
  const action = await getClickAction();
  if (action === 'popup') return; // popup was bound — shouldn't reach here

  // Fresh scan for a live page hint (the passive report's cv=/sp= goes stale
  // as the user pages through the viewer); stored results as fallback
  let merged;
  const fresh = await scanFrames(tab.id);
  if (fresh) {
    merged = mergeFrameEntries(fresh);
  } else {
    const entry = await new Promise(function (res) {
      chrome.storage.session.get('tab:' + tab.id, function (d) { res(d && d['tab:' + tab.id]); });
    });
    merged = mergeFrameEntries(entryFrameList(entry));
  }

  let best = pickBest(merged.results);
  if (best && best.needsResolve) best = await resolveAsyncBest(best, tab.url || '');
  if (!best || !best.url) {
    flashBadge(tab.id, '–', 'Sniiiffer — no IIIF manifest detected on this page');
    return;
  }

  try {
    if (action === 'copy-url') {
      await copyInTab(tab.id, best.url);
      flashBadge(tab.id, 'OK', 'Sniiiffer — manifest URL copied');
    } else if (action === 'copy-content-state') {
      const cs = await contentStateFor(best.url, merged.hint);
      await copyInTab(tab.id, cs.token);
      flashBadge(tab.id, 'OK', cs.page
        ? 'Sniiiffer — content state copied (page ' + cs.page + ')'
        : 'Sniiiffer — content state copied');
    } else if (action === 'open-whatiiif') {
      let cs = null;
      try { cs = await contentStateFor(best.url, merged.hint); } catch (e) {}
      const dest = cs
        ? WHATIIIF_BASE + '/?iiif-content=' + encodeURIComponent(cs.token)
        : WHATIIIF_BASE + '/?manifest=' + encodeURIComponent(best.url);
      chrome.tabs.create({ url: dest });
    } else if (action === 'highlight') {
      const cfg = await highlightConfigFor(best.url, merged.hint);
      if (!cfg) {
        flashBadge(tab.id, '!', 'Sniiiffer — could not prepare a highlight for this manifest');
        return;
      }
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['highlight.js'] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function (c) { __sniiifferHighlight(c); },
        args: [cfg]
      });
    }
  } catch (e) {
    flashBadge(tab.id, '!', 'Sniiiffer — action failed on this page');
  }
}

chrome.action.onClicked.addListener(function (tab) { handleClick(tab); });

/* ── message routing ── */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;
  if (msg.type === 'sniiiffer:found' && sender.tab && sender.tab.id >= 0) {
    updateTab(sender.tab.id, sender.frameId || 0, msg.pageUrl, msg.results || [], msg.hint);
    return;
  }
  if (msg.type === 'sniiiffer:deepScan') {
    deepScan(msg.pageUrl, msg.results || []).then(function (res) {
      if (typeof msg.tabId === 'number') updateTab(msg.tabId, 'deep', msg.pageUrl, res.results, null);
      sendResponse(res);
    });
    return true; // async sendResponse
  }
});
