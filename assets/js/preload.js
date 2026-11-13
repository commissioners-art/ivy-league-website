/* ---------------------------------------------------------------
   preload.js — loaded in <head> on every public page.
   Stops the "old template flashes, then my edits appear" effect:
   - re-applies the colours saved from the last visit before paint
   - hides editable text/images until app.js fills them in
   - on a first visit (nothing saved yet) hides the whole page instead,
     so the default colours never flash
   A safety timer always reveals the page, so the built-in template
   text still shows if Supabase is unreachable.
--------------------------------------------------------------- */
(function () {
  var root = document.documentElement;
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem('ivy.content') || 'null'); } catch (e) {}

  var VARS = { 'theme.ivy': '--ivy', 'theme.ivy_deep': '--ivy-deep', 'theme.brass': '--brass', 'theme.sprig': '--ivy-sprig' };
  if (cached) for (var k in VARS) if (cached[k]) root.style.setProperty(VARS[k], cached[k]);

  // Dark theme (assets/css/hud-theme.css) is the site's look. It is loaded
  // from here so every page that runs preload.js picks it up. Setting
  // site_content "theme.style" to "classic" turns it off for everyone.
  if (!(cached && cached['theme.style'] === 'classic')) {
    root.classList.add('hud');
    var v = (document.currentScript && document.currentScript.src.split('?')[1]) || '';
    document.write('<link rel="stylesheet" href="assets/css/hud-theme.css' + (v ? '?' + v : '') + '">');
  }

  root.classList.add('cms-loading');
  // No saved copy yet (first visit, or after the browser cleared it): the
  // custom colours aren't known either, so hold the whole page back
  // instead of flashing the default green.
  if (!cached) root.classList.add('cms-first');
  var style = document.createElement('style');
  style.textContent =
    'html.cms-loading [data-cms], html.cms-loading [data-cms-src] { visibility: hidden; }' +
    'html.cms-loading.cms-first body { visibility: hidden; }';
  document.head.appendChild(style);

  window.IVY_REVEAL = function () { root.classList.remove('cms-loading'); };
  setTimeout(window.IVY_REVEAL, 2500);
})();
