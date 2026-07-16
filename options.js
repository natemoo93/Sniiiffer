/* Sniiiffer options — a single setting: what a toolbar click does.
   Stored in chrome.storage.sync ('clickAction'); the background worker
   listens for changes and rebinds the popup / context menu accordingly. */

(function () {
  'use strict';

  const DEFAULT = 'popup';
  const radios = Array.prototype.slice.call(document.querySelectorAll('input[name="clickAction"]'));

  chrome.storage.sync.get({ clickAction: DEFAULT }, function (d) {
    const v = (d && d.clickAction) || DEFAULT;
    const hit = radios.filter(function (r) { return r.value === v; })[0] || radios[0];
    hit.checked = true;
  });

  radios.forEach(function (r) {
    r.addEventListener('change', function () {
      if (!r.checked) return;
      chrome.storage.sync.set({ clickAction: r.value }, function () {
        const s = document.getElementById('saved');
        s.textContent = 'Saved ✓';
        setTimeout(function () { s.textContent = ''; }, 1200);
      });
    });
  });
})();
