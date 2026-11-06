/* ---------------------------------------------------------------
   preload.js — loaded in <head> on every public page.
   Stops the "old template flashes, then my edits appear" effect:
   - re-applies the colours saved from the last visit before paint
   - hides editable text/images until app.js fills them in
   A safety timer always reveals the page, so the built-in template
   text still shows if Supabase is unreachable.
--------------------------------------------------------------- */
(function () {
  var root = document.documentElement;
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem('ivy.content') || 'null'); } catch (e) {}

  var VARS = { 'theme.ivy': '--ivy', 'theme.ivy_deep': '--ivy-deep', 'theme.brass': '--brass', 'theme.sprig': '--ivy-sprig' };
  if (cached) for (var k in VARS) if (cached[k]) root.style.setProperty(VARS[k], cached[k]);

  root.classList.add('cms-loading');
  var style = document.createElement('style');
  style.textContent = 'html.cms-loading [data-cms], html.cms-loading [data-cms-src] { visibility: hidden; }';
  document.head.appendChild(style);

  window.IVY_REVEAL = function () { root.classList.remove('cms-loading'); };
  setTimeout(window.IVY_REVEAL, 2500);
})();
