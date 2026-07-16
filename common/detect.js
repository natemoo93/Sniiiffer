/* Sniiiffer — shared IIIF manifest detection library.
   Pure functions only: no chrome.* and no DOM access, so the same file loads
   as a content script, via importScripts() in the service worker, and under
   Node for testing.

   Ported from whatiiif (../prod/index.html PLATFORMS + heuristicResolve, plus
   ../test/index-test.html experimental handlers). Three copies of this logic
   now exist — see "Duplicated logic" in ../test/CLAUDE.md. Differences from
   the whatiiif originals are deliberate and marked EXTENSION NOTE: the
   extension has host permissions, so every proxied fetch becomes a direct
   fetch and manifest URLs are always returned raw (never /manifest-proxy?url=
   wrapped — whatiiif does its own proxying when the user opens a link there).
*/

const SNIIIFFER_PROBE_CAP = 8; // max network probes per deep scan — capped for politeness
const WHATIIIF_BASE = 'https://whatiiif.com';

/* ── manifest validation (verbatim from whatiiif) ── */
function looksLikeManifest(data) {
  if (!data || typeof data !== 'object') return false;
  if (/iiif\.io\/api\/presentation/.test(JSON.stringify(data['@context'] || ''))) return true;
  const type = data['@type'] || data.type || '';
  return type === 'sc:Manifest' || type === 'Manifest' || type === 'sc:Collection' || type === 'Collection';
}

/* ── IIIF Content State API 1.0 encoding/decoding (from whatiiif) ── */
function encodeContentState(json) {
  const uriEncoded = encodeURIComponent(json);
  const b64 = btoa(uriEncoded);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// A content state referencing a whole Manifest (spec §2.2.2) — the token form
// other viewers accept via ?iiif-content=. Round-trips through
// parseContentState below.
function buildManifestContentState(manifestUrl) {
  return encodeContentState(JSON.stringify({
    '@context': 'http://iiif.io/api/presentation/3/context.json',
    id: manifestUrl,
    type: 'Manifest'
  }));
}

// A content state targeting a specific Canvas (spec §2.2.1 Annotation form,
// same shape whatiiif's buildContentStateAnnotation emits). xywh ("x,y,w,h",
// in the full image-pixel space whatiiif's selection UI uses) and label (the
// user's caption, spec language-map form whatiiif round-trips) are optional —
// present only for highlight-region states.
function buildCanvasContentState(manifestUrl, canvasId, xywh, label) {
  const annotation = {
    '@context': 'http://iiif.io/api/presentation/3/context.json',
    id: manifestUrl + '#content-state',
    type: 'Annotation',
    motivation: ['contentState'],
    target: {
      id: canvasId + (xywh ? '#xywh=' + xywh : ''),
      type: 'Canvas',
      partOf: [{ id: manifestUrl, type: 'Manifest' }]
    }
  };
  if (label) annotation.label = { none: [label] };
  return encodeContentState(JSON.stringify(annotation));
}

// whatiiif's own share-link form for a highlighted region — byte-identical to
// what its updateUrl() generates (?manifest=&canvas=&xywh=[&label=][&svc=]).
// svc lets whatiiif render the highlight even when the manifest itself is
// proxy-blocked there.
function buildWhatiiifHighlightUrl(manifestUrl, canvasIdx, xywh, label, svcBase) {
  const p = new URLSearchParams({ manifest: manifestUrl, canvas: String(canvasIdx), xywh: xywh });
  if (label) p.set('label', label);
  if (svcBase) p.set('svc', svcBase);
  return WHATIIIF_BASE + '/?' + p.toString();
}

/* ── page awareness: which canvas is the viewer showing? ──
   Extracts a canvas index from viewer-URL conventions. Deliberately
   conservative: only params/paths that are page positions on their platform.
   Generic ?page=/?seq= are skipped — on arbitrary sites they're usually
   search-result pagination, and a wrong canvas target is worse than none.
   Returns { index } (0-based) or null. */
function extractPageHint(pageUrl) {
  let m;
  // Library of Congress: ?sp=13 (1-based sequence position)
  if (/\bloc\.gov\//.test(pageUrl) && (m = pageUrl.match(/[?&]sp=(\d+)/))) {
    return { index: Math.max(0, parseInt(m[1], 10) - 1) };
  }
  // Cambridge CUDL: /view/{id}/42 (1-based path segment)
  if ((m = pageUrl.match(/cudl\.lib\.cam\.ac\.uk\/view\/[^\/\?#]+\/(\d+)/))) {
    return { index: Math.max(0, parseInt(m[1], 10) - 1) };
  }
  // Internet Archive BookReader: /page/n5 (n-prefixed = 0-based leaf, which
  // maps ~1:1 onto IA IIIF canvases; bare /page/5 is a PRINTED page number
  // with no reliable canvas mapping, so only the n-form is used)
  if (/archive\.org\/details\//.test(pageUrl) && (m = pageUrl.match(/\/page\/n(\d+)/))) {
    return { index: parseInt(m[1], 10) };
  }
  // Universal Viewer: #?cv=12 (0-based canvas index; UV runs on many domains,
  // often inside an iframe — the all-frames content script sees its live URL).
  // m= is UV's volume index within a collection: carried along so multi-volume
  // works can target the right volume (or bail rather than target the wrong one).
  if ((m = pageUrl.match(/[?&#]cv=(\d+)/))) {
    const mi = pageUrl.match(/[?&#]m=(\d+)/);
    return { index: parseInt(m[1], 10), manifestIndex: mi ? parseInt(mi[1], 10) : 0 };
  }
  // whatiiif share links: ?canvas=3 (0-based)
  if ((m = pageUrl.match(/[?&]canvas=(\d+)/))) {
    return { index: parseInt(m[1], 10) };
  }
  return null;
}

// v2 (sequences) vs v3 (items) — faithful port of whatiiif's getCanvases
function getCanvases(m) {
  if (m.sequences && m.sequences[0]) return m.sequences[0].canvases || [];
  return m.items || [];
}

// Collections have sub-manifests, not canvases — whatiiif (and most viewers)
// can't render them directly. collectionManifests lists the volume URLs
// (v2 manifests / v3 items), unwrapCollection is the volume-1 policy.
function collectionManifests(m) {
  const type = m['@type'] || m.type || '';
  if (type !== 'sc:Collection' && type !== 'Collection') return [];
  if (Array.isArray(m.manifests)) {
    return m.manifests.map(function (x) { return x['@id'] || x.id; }).filter(Boolean); // v2
  }
  if (Array.isArray(m.items)) {
    return m.items
      .filter(function (it) { return (it.type || it['@type']) === 'Manifest'; })
      .map(function (it) { return it.id || it['@id']; })
      .filter(Boolean); // v3
  }
  return [];
}
function unwrapCollection(m) {
  return collectionManifests(m)[0] || null;
}

function canvasIdOf(canvas) {
  return (canvas && (canvas.id || canvas['@id'])) || null;
}

/* ── canvas → image plumbing (verbatim ports from whatiiif index.html; these
   join the getCanvases/getLabel family in test/CLAUDE.md's duplicated-logic
   warning — a parsing fix here belongs in whatiiif too) ── */

// IIIF v3 servers use 'max' instead of 'full' for full resolution
function fullSizeParam(svcBase) {
  return (svcBase && svcBase.indexOf('/iiif/3/') !== -1) ? 'max' : 'full';
}

// Image API service base for a canvas (v2 images / v3 annotation body),
// falling back to the resource URL's stem when no service is declared
function getServiceBase(canvas) {
  if (canvas.images && canvas.images[0]) {
    const res = canvas.images[0].resource || {};
    const svc = res.service;
    if (svc) { const id = svc['@id'] || svc.id; if (typeof id === 'string' && id) return id.replace(/\/+$/, ''); }
    const rid = res['@id'] || res.id || '';
    const m = rid.match(/^(.+)\/(?:full|[\d,]+)\//);
    if (m) return m[1];
    return rid.replace(/\/+$/, '');
  }
  if (canvas.items && canvas.items[0] && canvas.items[0].items && canvas.items[0].items[0]) {
    const body = canvas.items[0].items[0].body || {};
    const s = Array.isArray(body.service) ? body.service[0] : body.service;
    if (s) { const sid = s['@id'] || s.id; if (typeof sid === 'string' && sid) return sid.replace(/\/+$/, ''); }
    const bid = body.id || body['@id'] || '';
    const m2 = bid.match(/^(.+)\/(?:full|[\d,]+)\//);
    if (m2) return m2[1];
    return bid.replace(/\/+$/, '');
  }
  return null;
}

function iiifUrl(base, region, size) {
  return base.replace(/\/+$/, '') + '/' + region + '/' + (size || '800,') + '/0/default.jpg';
}

// Full-pixel dimensions of the canvas — the coordinate space whatiiif's xywh
// values live in. Includes whatiiif's LoC fix: some institutions report
// canvas dims at a pct:-reduced derivative scale.
function getCanvasDimensions(canvas) {
  let cW = canvas.width || 1000;
  let cH = canvas.height || 1400;
  const images = canvas.images || [];
  if (images[0]) {
    const res = images[0].resource || {};
    const rid = res['@id'] || res.id || '';
    const pct = rid.match(/\/pct:([\d.]+)\//);
    // Only scale up when the canvas reports the derivative's reduced dims.
    // ChronAm canvases report full-res dims alongside a pct:12.5 resource —
    // scaling those up 8x misplaces the highlight rect.
    if (pct && (!res.width || Math.abs(cW - res.width) <= cW * 0.05)) {
      const scale = 100 / parseFloat(pct[1]);
      cW = Math.round(cW * scale);
      cH = Math.round(cH * scale);
    }
  }
  return { cW: cW, cH: cH };
}

/* Display-image candidates for a canvas, strongest first. The highlight
   overlay walks the list on <img> error: a sized service request first
   (level-1 syntax, fast), the service's full-resolution form, then the
   painted resource itself (also rescues the no-service case, where
   getServiceBase returns a plain image URL that the Image-API forms 404 on). */
function canvasImageUrls(canvas) {
  const urls = [];
  const svc = getServiceBase(canvas);
  if (svc) {
    urls.push(iiifUrl(svc, 'full', '1600,'));
    urls.push(iiifUrl(svc, 'full', fullSizeParam(svc)));
  }
  let direct = null;
  if (canvas.images && canvas.images[0]) {
    const res = canvas.images[0].resource || {};
    direct = res['@id'] || res.id || null;
  } else if (canvas.items && canvas.items[0] && canvas.items[0].items && canvas.items[0].items[0]) {
    const body = canvas.items[0].items[0].body || {};
    direct = body.id || body['@id'] || null;
  }
  if (direct && urls.indexOf(direct) === -1) urls.push(direct);
  return urls;
}

function decodeContentState(s) {
  const pad = s.length % 4;
  if (pad === 1) throw new Error('Invalid content state length');
  if (pad) s += '===='.slice(0, 4 - pad);
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(atob(b64));
}

function parseContentState(raw) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    return { manifestId: raw, canvasId: null, xywh: null };
  }
  let json;
  try { json = JSON.parse(decodeContentState(raw)); }
  catch (e) { return null; }
  let target = (json.motivation === 'contentState' || (Array.isArray(json.motivation) && json.motivation.indexOf('contentState') > -1))
    ? json.target
    : json;
  if (Array.isArray(target)) target = target[0];
  if (!target || !target.id) return null;
  let manifestId = null;
  if (target.type === 'Manifest') {
    manifestId = target.id;
  } else if (Array.isArray(target.partOf)) {
    const mp = target.partOf.find(function (p) { return p.type === 'Manifest'; });
    if (mp) manifestId = mp.id;
  } else if (target.partOf && target.partOf.type === 'Manifest') {
    manifestId = target.partOf.id;
  }
  return manifestId ? { manifestId: manifestId } : null;
}

/* ── Signposting Link header (from test/index-test.html — experimental).
   EXTENSION NOTE: whatiiif can't use this because /manifest-proxy drops the
   Link header; the extension reads response headers natively. ── */
function parseSignpostingManifest(linkHeader) {
  if (!linkHeader) return null;
  const entries = linkHeader.split(/,(?=\s*<)/);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const urlMatch = entry.match(/<([^>]+)>/);
    if (!urlMatch) continue;
    if (!/rel="?alternate"?/i.test(entry)) continue;
    if (!/profile="[^"]*iiif\.io\/api\/presentation[^"]*"|type="application\/ld\+json"/i.test(entry)) continue;
    return urlMatch[1];
  }
  return null;
}

/* ── Figgy resource type → /concern/ URL segment (from test) ── */
function figgyConcernType(type) {
  const slug = String(type || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!slug) return null;
  return /s$/.test(slug) ? slug : slug + 's';
}

/* ── PLATFORMS — URL pattern → manifest URL.
   Order matters: first match wins (same contract as whatiiif). Sync resolvers
   are pure (safe in the content script, zero network); async ones fetch and
   only run in the background service worker on deep scan. ── */
const PLATFORMS = [

  // Viewer share links (Theseus, Mirador, UV, whatiiif) — ?manifest= / #?manifest=.
  // DASH/HLS video players use ?manifest= too — those are never IIIF (this
  // fix belongs in the whatiiif copies as well; see the sync warning).
  {
    name: 'IIIF viewer link',
    pattern: /[?&#]manifest=/,
    resolve: function (url) {
      const m = url.match(/[?&#]manifest=([^&#\s]+)/);
      if (!m) return null;
      try {
        const dec = decodeURIComponent(m[1]);
        if (!/^https?:\/\//.test(dec)) return null;
        return looksLikeVideoManifest(dec) ? null : dec;
      } catch (e) { return null; }
    }
  },

  // Direct manifest URL — the page itself; content.js confirms by parsing the body
  {
    name: 'Direct manifest URL',
    pattern: /manifest(\.json)?(\?|#|$)/,
    resolve: function (url) { return url; }
  },

  // Illinois State University — Circus Route Books compound objects.
  // EXTENSION NOTE: direct dmwebservices fetch (whatiiif needs the proxy: no
  // CORS); the child-page canvas jump is whatiiif-app state and is dropped.
  {
    name: 'Illinois State University (Circus Route Books)',
    pattern: /digital\.library\.illinoisstate\.edu\/digital\/collection\/p15990coll5\/id\/(\d+)/,
    async: true,
    resolve: async function (url) {
      const m = url.match(/^(https?:\/\/[^\/]+).*\/digital\/collection\/(p15990coll5)\/id\/(\d+)/);
      if (!m) return null;
      const host = m[1], col = m[2], id = m[3];
      const childManifest = host + '/iiif/info/' + col + '/' + id + '/manifest.json';
      try {
        const r = await fetch(host + '/digital/bl/dmwebservices/index.php?q=GetParent/' + col + '/' + id + '/json');
        if (!r.ok) return childManifest;
        const data = await r.json();
        const parent = parseInt(data && data.parent, 10);
        if (parent > 0) return host + '/iiif/info/' + col + '/' + parent + '/manifest.json';
      } catch (e) {}
      return childManifest;
    }
  },

  // CONTENTdm — any domain
  {
    name: 'CONTENTdm',
    pattern: /\/digital\/collection\/([^\/]+)\/id\/(\d+)/,
    resolve: function (url) {
      const m = url.match(/^(https?:\/\/[^\/]+).*\/digital\/collection\/([^\/]+)\/id\/(\d+)/);
      if (!m) return null;
      return m[1] + '/iiif/info/' + m[2] + '/' + m[3] + '/manifest.json';
    }
  },

  // Internet Archive
  {
    name: 'Internet Archive',
    pattern: /archive\.org\/details\/([^\/\?]+)/,
    resolve: function (url) {
      const m = url.match(/archive\.org\/details\/([^\/\?#]+)/);
      if (!m) return null;
      return 'https://iiif.archive.org/iiif/' + m[1] + '/manifest.json';
    }
  },

  // Harvard viewer — ?manifestId= or canvasId=
  {
    name: 'Harvard Digital Collections',
    pattern: /viewer\.lib\.harvard\.edu\/viewer/,
    resolve: function (url) {
      const m = url.match(/[?&]manifestId=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
      const c = url.match(/[?&]canvasId=([^&]+)/);
      if (c) {
        const canvas = decodeURIComponent(c[1]);
        return canvas.replace(/\/canvas\/[^/]+$/, '');
      }
      return null;
    }
  },

  // Harvard nrs URN manifests
  {
    name: 'Harvard Digital Collections',
    pattern: /nrs\.lib\.harvard\.edu\/URN-3:[^?#\s]+:MANIFEST/i,
    resolve: function (url) {
      const m = url.match(/(https?:\/\/nrs\.lib\.harvard\.edu\/URN-3:[^?#\s]+:MANIFEST:\d+)/i);
      return m ? m[1] : null;
    }
  },

  // Harvard CURIOSity — LibraryCloud MMS-ID lookup → nrs URN manifest.
  // Prod version: DRS repo codes contain dots (FHCL.HOUGH); return the nrs
  // URL (303s to whichever mps version exists). LibraryCloud is incomplete —
  // some records resolve to nothing and that's terminal (see CLAUDE.md).
  {
    name: 'Harvard CURIOSity',
    pattern: /curiosity\.lib\.harvard\.edu\/[^\/]+\/catalog\/([^\/\?#]+)/,
    async: true,
    resolve: async function (url) {
      const m = url.match(/curiosity\.lib\.harvard\.edu\/[^\/]+\/catalog\/([^\/\?#]+)/);
      if (!m) return null;
      const mms = m[1].replace(/^\d+-/, '');
      try {
        const r = await fetch('https://api.lib.harvard.edu/v2/items.json?q=' + encodeURIComponent(mms), { headers: { 'Accept': 'application/json' } });
        if (!r.ok) return null;
        const text = await r.text();
        const urn = text.match(/urn-3:[A-Za-z0-9.]+:\d+/i);
        if (!urn) return null;
        return 'https://nrs.harvard.edu/' + urn[0] + ':MANIFEST';
      } catch (e) { return null; }
    }
  },

  // Library of Congress — item URLs
  {
    name: 'Library of Congress',
    pattern: /loc\.gov\/item\/([^\/\?]+)/,
    resolve: function (url) {
      const m = url.match(/(https?:\/\/www\.loc\.gov\/item\/[^\/\?#]+)/);
      if (!m) return null;
      return m[1].replace(/\/+$/, '') + '/manifest.json';
    }
  },

  // LoC Chronicling America — must precede the generic /resource/ handler
  {
    name: 'Library of Congress',
    pattern: /loc\.gov\/resource\/([^\/\?#]+)\/(\d{4}-\d{2}-\d{2})\/ed-(\d+)/,
    resolve: function (url) {
      const m = url.match(/loc\.gov\/resource\/([^\/\?#]+)\/(\d{4}-\d{2}-\d{2})\/ed-(\d+)/);
      if (!m) return null;
      return 'https://www.loc.gov/item/' + m[1] + '/' + m[2] + '/ed-' + m[3] + '/manifest.json';
    }
  },

  // LoC — generic resource URLs (?fo=json lookup; direct fetch, LoC serves ACAO *)
  {
    name: 'Library of Congress',
    pattern: /loc\.gov\/resource\/(?!sn\d)([^\/\?]+)/,
    async: true,
    resolve: async function (url) {
      const base = url.match(/(https?:\/\/www\.loc\.gov\/resource\/[^\/\?#]+)/);
      if (!base) return null;
      try {
        const r = await fetch(base[1].replace(/\/+$/, '') + '/?fo=json');
        if (!r.ok) return null;
        const data = await r.json();
        const lccn = data.segments && data.segments[0] && data.segments[0].number_lccn && data.segments[0].number_lccn[0];
        if (!lccn) return null;
        return 'https://www.loc.gov/item/' + lccn + '/manifest.json';
      } catch (e) { return null; }
    }
  },

  // Biodiversity Heritage Library — page carries an archive.org identifier.
  // EXTENSION NOTE: direct page fetch (whatiiif reads it through the proxy).
  {
    name: 'Biodiversity Heritage Library',
    pattern: /biodiversitylibrary\.org\/(item|bibliography)\/(\d+)/,
    async: true,
    resolve: async function (url) {
      try {
        const r = await fetch(url);
        const html = await r.text();
        const m = html.match(/archive\.org\/details\/([^"]+)/);
        if (!m) return null;
        return 'https://iiif.archive.org/iiif/' + m[1] + '/manifest.json';
      } catch (e) { return null; }
    }
  },

  // Smithsonian Libraries — resolves to an Internet Archive identifier.
  // EXTENSION NOTE: direct page fetch; raw IA manifest URL (no proxy wrap).
  {
    name: 'Smithsonian Libraries',
    pattern: /library\.si\.edu\/digital-library\/book\/([^\/\?#]+)/,
    async: true,
    resolve: async function (url) {
      const m = url.match(/library\.si\.edu\/digital-library\/book\/([^\/\?#]+)/);
      if (!m) return null;
      try {
        const page = await fetch(url);
        const html = await page.text();
        const ia = html.match(/archive\.org\/(?:details|stream)\/([^"'\/#\?]+)/);
        if (ia) return 'https://iiif.archive.org/iiif/' + ia[1] + '/manifest.json';
      } catch (e) {}
      return 'https://iiif.archive.org/iiif/' + m[1] + '/manifest.json';
    }
  },

  // Cambridge Digital Library
  {
    name: 'Cambridge Digital Library',
    pattern: /cudl\.lib\.cam\.ac\.uk\/view\/([^\/\?#]+)/,
    resolve: function (url) {
      const m = url.match(/cudl\.lib\.cam\.ac\.uk\/view\/([^\/\?#]+)/);
      if (!m) return null;
      return 'https://cudl.lib.cam.ac.uk/iiif/' + m[1];
    }
  },

  // Yale Library. EXTENSION NOTE: raw manifest URL — whatiiif wraps this in
  // its proxy because Yale manifests lack CORS, but that's a whatiiif concern.
  {
    name: 'Yale Library',
    pattern: /collections\.library\.yale\.edu\/catalog\/(\d+)/,
    resolve: function (url) {
      const m = url.match(/collections\.library\.yale\.edu\/catalog\/(\d+)/);
      if (!m) return null;
      return 'https://collections.library.yale.edu/manifests/' + m[1];
    }
  },

  // UCLA Digital Collections
  {
    name: 'UCLA Digital Collections',
    pattern: /digital\.library\.ucla\.edu\/catalog\/(ark:\/\d+\/[^\/\?#]+)/,
    resolve: function (url) {
      const m = url.match(/digital\.library\.ucla\.edu\/catalog\/(ark:\/\d+\/[^\/\?#]+)/);
      if (!m) return null;
      try { return 'https://iiif.library.ucla.edu/' + encodeURIComponent(m[1]) + '/manifest'; }
      catch (e) { return null; }
    }
  },

  // Princeton DPUL — Figgy search by ARK tail (the DPUL page itself Turnstiles
  // datacenter IPs; irrelevant here, but Figgy search is authoritative anyway).
  // EXTENSION NOTE: direct Figgy fetches (whatiiif proxies the search: no CORS).
  {
    name: 'Princeton University Library',
    pattern: /dpul\.princeton\.edu\/(?:[^\/]+\/)?catalog\/([^\/\?#]+)/,
    async: true,
    resolve: async function (url) {
      const idM = url.match(/dpul\.princeton\.edu\/(?:[^\/]+\/)?catalog\/([^\/\?#]+)/);
      if (!idM) return null;
      const id = idM[1];
      try {
        const r = await fetch('https://figgy.princeton.edu/catalog.json?q=' + encodeURIComponent(id));
        if (!r.ok) return null;
        const data = await r.json();
        const docs = (data && data.data) || [];
        const doc = docs.filter(function (d) {
          const ident = d.attributes && d.attributes.identifier_ssim;
          const vals = [].concat((ident && ident.attributes && ident.attributes.value) || []);
          return vals.some(function (v) { return typeof v === 'string' && v.slice(-id.length) === id; });
        })[0];
        if (!doc || !doc.id || !doc.type) return null;
        const slug = figgyConcernType(doc.type);
        if (!slug) return null;
        const manifestUrl = 'https://figgy.princeton.edu/concern/' + slug + '/' + doc.id + '/manifest';
        const mr = await fetch(manifestUrl);
        if (!mr.ok) return null;
        const mj = await mr.json();
        if (mj['@type'] === 'sc:Collection') {
          const vol = mj.manifests && mj.manifests[0];
          return (vol && vol['@id']) || null;
        }
        return manifestUrl;
      } catch (e) { return null; }
    }
  },

  // Princeton main catalog (EXPERIMENTAL — from test/index-test.html):
  // Alma bib ID → Figgy Blacklight search → /concern/ manifest.
  {
    name: 'Princeton University Library',
    pattern: /catalog\.princeton\.edu\/catalog\/(\d+)/,
    async: true,
    resolve: async function (url) {
      const bibM = url.match(/catalog\.princeton\.edu\/catalog\/(\d+)/);
      if (!bibM) return null;
      const bib = bibM[1];
      try {
        const r = await fetch('https://figgy.princeton.edu/catalog.json?q=' + encodeURIComponent(bib));
        if (!r.ok) return null;
        const data = await r.json();
        const docs = (data && data.data) || [];
        const doc = docs.filter(function (d) {
          const ids = (d.attributes && d.attributes.source_metadata_identifier_ssim) || [];
          return (Array.isArray(ids) ? ids : [ids]).indexOf(bib) > -1;
        })[0] || docs[0];
        if (!doc || !doc.id) return null;
        const subtype = figgyConcernType(doc.type);
        if (!subtype) return null;
        return 'https://figgy.princeton.edu/concern/' + subtype + '/' + doc.id + '/manifest';
      } catch (e) { return null; }
    }
  },

  // Stanford SearchWorks (EXPERIMENTAL — from test): druid → PURL manifest
  {
    name: 'Stanford (SearchWorks)',
    pattern: /searchworks\.stanford\.edu\/view\/([a-z]{2}\d{3}[a-z]{2}\d{4})/i,
    resolve: function (url) {
      const m = url.match(/searchworks\.stanford\.edu\/view\/([a-z]{2}\d{3}[a-z]{2}\d{4})/i);
      if (!m) return null;
      return 'https://purl.stanford.edu/' + m[1] + '/iiif/manifest';
    }
  },

  // Dartmouth Digital Collections (EXPERIMENTAL — from test): SPA shell, but
  // the manifest sits at a parallel /archive/iiif/ path with -mods.json suffix
  {
    name: 'Dartmouth Digital Collections',
    pattern: /collections\.dartmouth\.edu\/archive\/object\/([^\/]+)\/([^\/\?#]+)/,
    resolve: function (url) {
      const m = url.match(/collections\.dartmouth\.edu\/archive\/object\/([^\/]+)\/([^\/\?#]+)/);
      if (!m) return null;
      return 'https://collections.dartmouth.edu/archive/iiif/' + m[1] + '/' + m[2] + '-mods.json';
    }
  },

  // Northwestern University Libraries Digital Collections (from a community
  // whatiiif fork, not yet upstream): work UUID in the item URL → v2 API
  // ?as=iiif (Presentation 3). API is CORS-open (reflects Origin), no proxy.
  {
    name: 'Northwestern University Libraries Digital Collections',
    pattern: /dc\.library\.northwestern\.edu\/items\/([^\/\?#]+)/,
    resolve: function (url) {
      const m = url.match(/dc\.library\.northwestern\.edu\/items\/([^\/\?#]+)/);
      if (!m) return null;
      return 'https://api.dc.library.northwestern.edu/api/v2/works/' + m[1] + '?as=iiif';
    }
  }
];

function detectPlatform(url) {
  for (let i = 0; i < PLATFORMS.length; i++) {
    if (PLATFORMS[i].pattern.test(url)) return PLATFORMS[i];
  }
  return null;
}

/* ── page-scan heuristics (ported from whatiiif heuristicResolve, with
   per-candidate source labels). Pure regex over an HTML string: the content
   script passes the rendered DOM's outerHTML (catches SPA state the static
   HTML lacks), tests pass fetched HTML. Zero network — candidates here are
   *leads*, validated only during deep scan. ── */

// Trailing id-ish segment of a URL — used for derived guesses and ranking
function trailingIdSegment(pageUrl) {
  const base = pageUrl.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return (base.match(/([A-Za-z0-9._%-]{4,})$/) || [])[1] || null;
}

// Streaming-video manifests — every embedded video player talks about
// "manifest" URLs and none of them are IIIF: MPEG-DASH (.mpd), HLS (.m3u8),
// Smooth Streaming (.ism/Manifest, .ismc), HDS (.f4m), Azure Media's
// /manifest(format=…). Central guard for every candidate path.
function looksLikeVideoManifest(url) {
  return /\.(mpd|m3u8|ism[cv]?|f4m)([?#]|$)/i.test(url) ||
         /\.ism\/manifest/i.test(url) ||
         /\/manifest\(format=/i.test(url);
}

// Resolve a scanned candidate (absolute, relative, or HTML-escaped) against
// the page URL; http(s) only, Image API info.json excluded.
// EXTENSION NOTE (precision): the extension scans EVERY page the user
// visits, so it needs exclusions whatiiif's paste-a-URL flow doesn't —
// streaming-video manifests and web-asset files (PWA .webmanifest, bundler
// manifest.*.js) share the word "manifest" but can never be IIIF.
function resolveCandidateUrl(raw, baseUrl) {
  if (!raw) return null;
  try {
    const u = new URL(raw.replace(/&amp;/g, '&'), baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (/\/info\.json$/.test(u.pathname)) return null;
    if (looksLikeVideoManifest(u.href)) return null;
    if (/\.(webmanifest|js|mjs|css|map|appcache)([?#]|$)/i.test(u.pathname)) return null;
    return u.href;
  } catch (e) {}
  return null;
}

function scanHtml(html, baseUrl) {
  const found = [];   // {url, source} — insertion order encodes source priority
  const push = function (raw, source) {
    const abs = resolveCandidateUrl(raw, baseUrl);
    if (abs) found.push({ url: abs, source: source });
  };
  // Viewer configs embed JSON with escaped slashes (https:\/\/…)
  const hay = html.replace(/\\\//g, '/');
  let m;

  // HTML Signposting <link> tags (type must end at json or ;params —
  // application/json+oembed is on practically every WordPress page)
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(hay))) {
    const tag = m[0];
    if (!/rel=["'][^"']*\b(?:alternate|describedby)\b/i.test(tag)) continue;
    if (!/type=["']application\/(?:ld\+)?json\s*(?:;|["'])/i.test(tag)) continue;
    const h = tag.match(/href=["']([^"']+)["']/i);
    if (h) push(h[1], 'signposting-html');
  }
  // Embedded viewer links: ?manifest=<url>
  const qRe = /[?&](?:amp;)?manifest=([^&"'<>\s]+)/g;
  while ((m = qRe.exec(hay))) {
    let dec = m[1];
    try { dec = decodeURIComponent(dec); } catch (e) {}
    push(dec, 'viewer-link');
  }
  // Content-state links: ?iiif-content=<uri-or-token>
  const csRe = /[?&](?:amp;)?iiif-content=([^&"'<>\s]+)/g;
  while ((m = csRe.exec(hay))) {
    let tok = m[1];
    try { tok = decodeURIComponent(tok); } catch (e) {}
    const cs = parseContentState(tok);
    if (cs && cs.manifestId) push(cs.manifestId, 'content-state');
  }
  // Viewer-config JSON keys (value must contain a slash)
  const keyRe = /["'](?:iiif[_-]?manifest|manifest[_-]?(?:url|uri|id)?)["']\s*:\s*["']([^"']*\/[^"']*)["']/gi;
  while ((m = keyRe.exec(hay))) push(m[1], 'config-key');
  // Embed-widget data attributes. data-manifest(-url) and data-iiif-* are
  // explicit; bare data-uri (Universal Viewer's) is also used by video
  // players and generic widgets, so its value must mention iiif/manifest.
  const attrRe = /data-(iiif-)?(manifest(?:-url)?|uri)=["']([^"']*\/[^"']*)["']/gi;
  while ((m = attrRe.exec(hay))) {
    if (!m[1] && m[2] === 'uri' && !/iiif|manifest/i.test(m[3])) continue;
    push(m[3], 'data-attribute');
  }
  // Any absolute URL mentioning "manifest"
  const urlRe = /https?:\/\/[^"'<>\s\\]*manifest[^"'<>\s\\]*/gi;
  while ((m = urlRe.exec(hay))) push(m[0], 'bare-url');

  // Platform tells → derived guesses (unvalidated until deep scan)
  const base = baseUrl.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const idSeg = trailingIdSegment(baseUrl);
  // TIND (Berkeley digicoll, CERN…): manifest link built in JS, but the fixed
  // route fragment sits in the markup (verified live 2026-07-12)
  if (/\/export\/iiif_manifest/.test(hay)) found.push({ url: base + '/export/iiif_manifest', source: 'tind-route' });
  // Image API thumbnails without a manifest link: on Digirati-style hosting
  // the manifest lives at {host}/iiif/manifest/{page-id}.json (verified live:
  // Bodleian 2026-07-12)
  const im = hay.match(/(https?:\/\/[^"'<>\s\\\/]+)\/iiif\/image\//i);
  if (im && idSeg) found.push({ url: im[1] + '/iiif/manifest/' + idSeg + '.json', source: 'image-api-host' });

  return rankCandidates(dedupeByUrl(found), baseUrl);
}

// Keep first occurrence per URL — insertion order encodes source priority
function dedupeByUrl(items) {
  const seen = {};
  return items.filter(function (it) {
    if (seen[it.url]) return false;
    seen[it.url] = true;
    return true;
  });
}

// Validation proves a candidate IS a manifest, not the RIGHT one — rank
// candidates sharing the page URL's trailing id segment first (stable).
function rankCandidates(items, pageUrl) {
  const idSeg = trailingIdSegment(pageUrl);
  if (!idSeg) return items;
  const pref = [], rest = [];
  items.forEach(function (it) { (it.url.indexOf(idSeg) !== -1 ? pref : rest).push(it); });
  return pref.concat(rest);
}

// Blind suffix guesses — deep scan only (they're pure 404 probes on most sites)
function suffixGuesses(pageUrl) {
  const base = pageUrl.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return [
    { url: base + '/manifest.json', source: 'suffix-guess' },
    { url: base + '/manifest', source: 'suffix-guess' },
    { url: base + '/iiif/manifest', source: 'suffix-guess' }
  ];
}

/* ── Node export for tests (ignored in extension contexts) ── */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SNIIIFFER_PROBE_CAP: SNIIIFFER_PROBE_CAP,
    WHATIIIF_BASE: WHATIIIF_BASE,
    looksLikeManifest: looksLikeManifest,
    encodeContentState: encodeContentState,
    buildManifestContentState: buildManifestContentState,
    buildCanvasContentState: buildCanvasContentState,
    buildWhatiiifHighlightUrl: buildWhatiiifHighlightUrl,
    extractPageHint: extractPageHint,
    getCanvases: getCanvases,
    collectionManifests: collectionManifests,
    unwrapCollection: unwrapCollection,
    canvasIdOf: canvasIdOf,
    fullSizeParam: fullSizeParam,
    getServiceBase: getServiceBase,
    iiifUrl: iiifUrl,
    getCanvasDimensions: getCanvasDimensions,
    canvasImageUrls: canvasImageUrls,
    decodeContentState: decodeContentState,
    parseContentState: parseContentState,
    parseSignpostingManifest: parseSignpostingManifest,
    figgyConcernType: figgyConcernType,
    PLATFORMS: PLATFORMS,
    detectPlatform: detectPlatform,
    trailingIdSegment: trailingIdSegment,
    looksLikeVideoManifest: looksLikeVideoManifest,
    resolveCandidateUrl: resolveCandidateUrl,
    scanHtml: scanHtml,
    dedupeByUrl: dedupeByUrl,
    rankCandidates: rankCandidates,
    suffixGuesses: suffixGuesses
  };
}
