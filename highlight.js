/* Sniiiffer highlight overlay — injected on demand by the popup's
   "Highlight…" button, never part of the always-on content scripts.

   Shows the CURRENT page's canvas image in a full-viewport overlay; the user
   drags a box on it, an optional caption field appears underneath the box,
   and two live-updating share links sit with it: the raw IIIF Content State
   token (any compatible viewer) and the whatiiif highlight link (copy/open).

   Drawing happens on our own copy of the image rather than over the host
   page's viewer: OpenSeadragon-style viewers render into a <canvas> whose
   pan/zoom transform is invisible from outside, so screen→canvas coordinate
   mapping over the live viewer can't be done reliably. On our copy the
   mapping is exact — box fractions × cfg.cW/cH (the full-pixel space
   whatiiif's xywh convention uses).

   Runs in the extension's isolated world alongside common/detect.js, but NOT
   in its scope: executeScript({files}) gives each injected file its own
   top-level scope, and detect.js's const/function declarations aren't
   globalThis properties. It therefore publishes buildCanvasContentState /
   buildWhatiiifHighlightUrl / WHATIIIF_BASE on globalThis explicitly; the
   guard below turns a regression there into a visible error instead of an
   overlay that silently never produces links.
   Only network activity: loading the page image itself.

   No top-level const/let and everything hangs off globalThis, so re-injecting
   this file is harmless (executeScript can't know it already ran). */

(function () {
  'use strict';

  var OVERLAY_ID = 'sniiiffer-highlight-overlay';
  // whatiiif palette (popup.html :root vars)
  var INK = '#1a1814', INK_MID = '#4a4540', INK_FAINT = '#8a8480';
  var ACCENT = '#7a3b1e', ACCENT_LIGHT = '#c4886a', BG = '#f5ede8';
  var FONT = "13px/1.5 system-ui,'Segoe UI',sans-serif";

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text) n.textContent = text;
    return n;
  }
  function btnStyle() {
    return "font:600 11px system-ui,'Segoe UI',sans-serif;cursor:pointer;" +
      'padding:3px 9px;border-radius:3px;border:1px solid ' + ACCENT +
      ';background:#fff;color:' + ACCENT + ';flex:none;';
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // Fail fast and visibly: these come from common/detect.js via globalThis.
  // Throwing here (before the overlay exists) surfaces the error to the
  // caller's executeScript promise, which reports it in the popup — the old
  // behaviour was a ReferenceError inside the drag handler, i.e. an overlay
  // that opened and then quietly produced nothing.
  globalThis.__sniiifferHighlightReady = function () {
    return typeof globalThis.buildCanvasContentState === 'function' &&
           typeof globalThis.buildWhatiiifHighlightUrl === 'function' &&
           typeof globalThis.WHATIIIF_BASE === 'string';
  };

  globalThis.__sniiifferHighlight = function (cfg) {
    if (!globalThis.__sniiifferHighlightReady()) {
      throw new Error('Sniiiffer: detect.js helpers unavailable in this frame');
    }
    // one overlay at a time — tear down a previous one cleanly (listeners too)
    if (typeof globalThis.__sniiifferHighlightClose === 'function') globalThis.__sniiifferHighlightClose();

    var sel = null;        // drawn box as fractions of the image (0..1) — survives window resizes for free
    var dragStart = null;
    var currentToken = '', currentLink = '';

    /* ── skeleton ── */
    var overlay = el('div', 'position:fixed;inset:0;z-index:2147483646;background:rgba(26,24,20,.82);' +
      'display:flex;flex-direction:column;font:' + FONT + ';color:' + INK + ';');
    overlay.id = OVERLAY_ID;

    var bar = el('div', 'flex:none;display:flex;align-items:center;gap:.7rem;padding:9px 16px;' +
      'background:' + BG + ';border-bottom:2px solid ' + ACCENT_LIGHT + ';');
    bar.appendChild(el('span', 'font-weight:600;color:' + ACCENT + ';letter-spacing:.02em;', 'Sniiiffer'));
    bar.appendChild(el('span', 'flex:1;color:' + INK_MID + ';font-size:.85rem;',
      'Drag a box over the region you want to highlight'));

    /* ── page picker ──
       The viewer's open page can't always be detected (Mirador/Clover keep it
       in JS state, and landing pages have none), so the overlay opens on
       page 1. This lets the user correct it by hand. Everything downstream —
       the content-state token, the whatiiif link, the image, the coordinate
       space — is rebuilt from the chosen canvas, so a manually-set page is
       indistinguishable from a detected one. */
    var pages = cfg.pages || null;
    var total = cfg.pageCount || (pages ? pages.length : 0);
    var curIdx = cfg.canvasIndex || 0;

    var pageWrap = el('div', 'display:flex;align-items:center;gap:5px;color:' + INK_MID + ';font-size:.8rem;');
    var prevBtn = el('button', btnStyle() + 'padding:2px 7px;', '‹');
    var pageInput = el('input', 'width:4.2rem;font:inherit;font-size:.8rem;text-align:center;padding:3px 4px;' +
      'border:1px solid ' + ACCENT_LIGHT + ';background:#fff;color:' + INK + ';outline:none;');
    var nextBtn = el('button', btnStyle() + 'padding:2px 7px;', '›');
    pageInput.type = 'number';
    pageInput.min = '1';
    pageInput.title = 'Page currently shown — type a number to jump';
    if (total) { pageInput.max = String(total); }
    pageWrap.appendChild(el('span', '', 'Page'));
    pageWrap.appendChild(prevBtn);
    pageWrap.appendChild(pageInput);
    if (total) pageWrap.appendChild(el('span', 'color:' + INK_FAINT + ';', 'of ' + total));
    pageWrap.appendChild(nextBtn);
    // Only offer the control when we actually have canvases to switch between
    if (pages && total > 1) bar.appendChild(pageWrap);

    var closeBtn = el('button', btnStyle() + 'padding:3px 12px;', '✕ Close (Esc)');
    bar.appendChild(closeBtn);
    overlay.appendChild(bar);

    var stage = el('div', 'flex:1;display:flex;align-items:center;justify-content:center;min-height:0;padding:20px;');
    var loading = el('div', 'color:' + BG + ';font-size:.9rem;max-width:32rem;text-align:center;', 'Loading page image…');
    var wrap = el('div', 'position:relative;display:none;box-shadow:0 8px 40px rgba(0,0,0,.5);');
    var img = el('img', 'display:block;max-width:calc(100vw - 48px);max-height:calc(100vh - 130px);' +
      'user-select:none;-webkit-user-select:none;background:#fff;');
    img.draggable = false;
    var box = el('div', 'position:absolute;display:none;border:2px solid ' + ACCENT +
      ';background:rgba(122,59,30,.18);box-shadow:0 0 0 1px rgba(255,255,255,.6);pointer-events:none;');
    var draw = el('div', 'position:absolute;inset:0;cursor:crosshair;touch-action:none;');
    wrap.appendChild(img);
    wrap.appendChild(box);
    wrap.appendChild(draw);
    stage.appendChild(loading);
    stage.appendChild(wrap);
    overlay.appendChild(stage);

    /* ── result panel (caption + live links), positioned under the drawn box ── */
    var panel = el('div', 'position:fixed;display:none;width:380px;max-width:calc(100vw - 24px);' +
      'background:' + BG + ';border:1px solid ' + ACCENT_LIGHT + ';border-radius:4px;' +
      'box-shadow:0 6px 28px rgba(0,0,0,.45);padding:10px 12px;');

    var cap = el('input', 'width:100%;box-sizing:border-box;font:inherit;padding:5px 8px;margin-bottom:8px;' +
      'border:1px solid ' + ACCENT_LIGHT + ';background:#fff;color:' + INK + ';outline:none;');
    cap.type = 'text';
    cap.placeholder = 'Caption / label (optional)';
    cap.addEventListener('input', update);
    // keep keystrokes away from the host page's viewer hotkeys; Esc = leave
    // the field, not the overlay
    cap.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); cap.blur(); }
    });
    panel.appendChild(cap);

    function linkRow(labelText) {
      var row = el('div', 'margin-bottom:8px;');
      row.appendChild(el('div', 'font-size:.62rem;text-transform:uppercase;letter-spacing:.08em;' +
        'color:' + INK_FAINT + ';margin-bottom:2px;', labelText));
      var line = el('div', 'display:flex;align-items:center;gap:6px;');
      var val = el('div', 'flex:1;min-width:0;font-family:Consolas,monospace;font-size:.68rem;' +
        'color:' + INK_MID + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
      line.appendChild(val);
      row.appendChild(line);
      panel.appendChild(row);
      return { val: val, line: line };
    }
    function button(text, onClick) {
      var b = el('button', btnStyle(), text);
      b.addEventListener('click', onClick);
      return b;
    }
    function copyText(text) {
      return navigator.clipboard.writeText(text).catch(function () {
        // http pages / clipboard API denied — legacy path
        var ta = el('textarea', 'position:fixed;opacity:0;');
        ta.value = text;
        overlay.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        ta.remove();
      });
    }
    function copyBtn(getText) {
      var b = button('Copy', function () {
        var t = getText();
        if (!t) return;
        copyText(t).then(function () {
          b.textContent = 'Copied';
          setTimeout(function () { b.textContent = 'Copy'; }, 1500);
        });
      });
      return b;
    }

    var wiRow = linkRow('whatiiif highlight link');
    wiRow.line.appendChild(copyBtn(function () { return currentLink; }));
    wiRow.line.appendChild(button('Open ↗', function () {
      if (currentLink) window.open(currentLink, '_blank', 'noopener');
    }));
    var csRow = linkRow('IIIF Content State — paste into any compatible viewer');
    csRow.line.appendChild(copyBtn(function () { return currentToken; }));
    overlay.appendChild(panel);

    /* ── live link generation ── */
    function xywh() {
      if (!sel) return null;
      return Math.round(sel.x * cfg.cW) + ',' + Math.round(sel.y * cfg.cH) + ',' +
        Math.max(1, Math.round(sel.w * cfg.cW)) + ',' + Math.max(1, Math.round(sel.h * cfg.cH));
    }
    function update() {
      var region = xywh();
      if (!region) return;
      var label = cap.value.trim() || null;
      currentToken = buildCanvasContentState(cfg.manifestUrl, cfg.canvasId, region, label);
      currentLink = buildWhatiiifHighlightUrl(cfg.manifestUrl, cfg.canvasIndex, region, label, cfg.svcBase || null);
      csRow.val.textContent = currentToken;
      csRow.val.title = currentToken;
      wiRow.val.textContent = currentLink;
      wiRow.val.title = currentLink;
    }

    /* ── panel placement: under the box; above it when there's no room below;
       pinned to the viewport bottom as a last resort ── */
    function positionPanel() {
      if (!sel || panel.style.display === 'none') return;
      var wr = wrap.getBoundingClientRect();
      var pw = panel.offsetWidth, ph = panel.offsetHeight;
      var left = clamp(wr.left + sel.x * wr.width, 12, Math.max(12, window.innerWidth - pw - 12));
      var top = wr.top + (sel.y + sel.h) * wr.height + 10;
      if (top + ph > window.innerHeight - 12) top = wr.top + sel.y * wr.height - ph - 10;
      if (top < 12) top = Math.max(12, window.innerHeight - ph - 12);
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    }
    function showPanel() {
      panel.style.display = 'block';
      positionPanel();
      cap.focus();
    }

    /* ── drawing (drag again to replace the box) ── */
    function renderBox() {
      if (!sel) { box.style.display = 'none'; return; }
      box.style.display = 'block';
      box.style.left = (sel.x * 100) + '%';
      box.style.top = (sel.y * 100) + '%';
      box.style.width = (sel.w * 100) + '%';
      box.style.height = (sel.h * 100) + '%';
    }
    draw.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      draw.setPointerCapture(e.pointerId);
      var r = draw.getBoundingClientRect();
      dragStart = { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
      sel = { x: dragStart.x, y: dragStart.y, w: 0, h: 0 };
      panel.style.display = 'none';
      renderBox();
    });
    draw.addEventListener('pointermove', function (e) {
      if (!dragStart) return;
      var r = draw.getBoundingClientRect();
      var cx = clamp((e.clientX - r.left) / r.width, 0, 1);
      var cy = clamp((e.clientY - r.top) / r.height, 0, 1);
      sel = {
        x: Math.min(dragStart.x, cx), y: Math.min(dragStart.y, cy),
        w: Math.abs(cx - dragStart.x), h: Math.abs(cy - dragStart.y)
      };
      renderBox();
    });
    draw.addEventListener('pointerup', function () {
      if (!dragStart) return;
      dragStart = null;
      var r = draw.getBoundingClientRect();
      if (!sel || sel.w * r.width < 8 || sel.h * r.height < 8) {
        sel = null; // a click, not a drag
        renderBox();
        return;
      }
      showPanel();
      update();
    });

    // index into cfg.imageUrls for the fallback walk below; declared here
    // because setPage() resets it when switching pages
    var urlIdx = 0;

    /* ── page switching ──
       Rebinds every per-canvas value update() reads (canvasId, canvasIndex,
       cW/cH, svcBase) and reloads the image. The drawn box is DISCARDED: its
       fractions were measured against the old page and its pixel coordinates
       are meaningless on a different canvas — silently carrying it over would
       emit a plausible-looking but wrong region. */
    function setPage(n) {
      if (!pages || !total) return;
      var i = Math.max(0, Math.min(total - 1, (parseInt(n, 10) || 1) - 1));
      pageInput.value = String(i + 1);
      if (i === curIdx) return;
      curIdx = i;
      var p = pages[i];
      cfg.canvasId = p.canvasId;
      cfg.canvasIndex = i;
      cfg.cW = p.cW;
      cfg.cH = p.cH;
      cfg.svcBase = p.svcBase;
      cfg.imageUrls = p.imageUrls || [];
      cfg.page = i + 1;
      // drop the stale selection and its links
      sel = null;
      dragStart = null;
      currentToken = '';
      currentLink = '';
      renderBox();
      panel.style.display = 'none';
      // show the loader again while the new page's image arrives
      urlIdx = 0;
      wrap.style.display = 'none';
      loading.textContent = 'Loading page image…';
      loading.style.display = '';
      img.src = cfg.imageUrls[0] || '';
      prevBtn.disabled = (curIdx === 0);
      nextBtn.disabled = (curIdx === total - 1);
    }
    pageInput.value = String(curIdx + 1);
    prevBtn.disabled = (curIdx === 0);
    nextBtn.disabled = (curIdx === total - 1);
    prevBtn.addEventListener('click', function () { setPage(curIdx); });   // curIdx is 0-based → this is "previous"
    nextBtn.addEventListener('click', function () { setPage(curIdx + 2); });
    pageInput.addEventListener('change', function () { setPage(pageInput.value); });
    // commit on Enter, and keep keystrokes off the host page's viewer hotkeys
    pageInput.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); setPage(pageInput.value); pageInput.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); pageInput.blur(); }
    });

    /* ── image loading with fallback walk (sized service → full-res service →
       painted resource) ── */
    img.addEventListener('load', function () {
      loading.style.display = 'none';
      wrap.style.display = 'inline-block';
    });
    img.addEventListener('error', function () {
      urlIdx++;
      if (urlIdx < cfg.imageUrls.length) { img.src = cfg.imageUrls[urlIdx]; return; }
      // all candidates failed (site CSP or a locked-down image server) —
      // hand off to whatiiif's own selection UI on the same page
      loading.textContent = 'The page image could not be loaded here. ';
      var alt = button('Highlight in whatiiif instead ↗', function () {
        window.open(WHATIIIF_BASE + '/?manifest=' + encodeURIComponent(cfg.manifestUrl) +
          '&canvas=' + cfg.canvasIndex, '_blank', 'noopener');
      });
      alt.style.marginLeft = '6px';
      loading.appendChild(alt);
    });
    img.src = cfg.imageUrls[0];

    /* ── lifecycle ── */
    function onKey(e) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (document.activeElement === cap) { cap.blur(); return; }
      close();
    }
    function close() {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', positionPanel);
      overlay.remove();
      delete globalThis.__sniiifferHighlightClose;
    }
    globalThis.__sniiifferHighlightClose = close;
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', positionPanel);

    (document.body || document.documentElement).appendChild(overlay);
  };
})();
