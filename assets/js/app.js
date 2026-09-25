/* ---------------------------------------------------------------
   app.js — shared plumbing for every public page.
   - creates the Supabase client
   - renders the header and footer
   - swaps in editable text/images saved by admins ([data-cms])
   - date/time + clock helpers used by the schedule and scoreboard
--------------------------------------------------------------- */
const CFG = window.IVY_CONFIG;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
window.sb = sb;

/* ---------- helpers ---------- */
const TZ = CFG.TIMEZONE || 'America/Toronto';

const fmtDate = (iso, opts = {}) =>
  new Date(iso).toLocaleDateString('en-CA', {
    weekday: 'short', month: 'short', day: 'numeric',
    timeZone: TZ, ...opts
  });

const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString('en-CA', {
    hour: 'numeric', minute: '2-digit', timeZone: TZ
  });

const fmtClock = (secs) => {
  const s = Math.max(0, Math.round(secs));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/* Remaining time on a running clock, derived from the last admin write. */
function liveClockSeconds(game) {
  if (!game) return 0;
  if (!game.clock_running) return game.clock_seconds ?? 0;
  const elapsed = (Date.now() - new Date(game.clock_updated_at).getTime()) / 1000;
  return Math.max(0, (game.clock_seconds ?? 0) - elapsed);
}

const ordinal = (n) => ['', '1st', '2nd', '3rd', 'OT', 'SO'][n] || `${n}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

window.Ivy = { fmtDate, fmtTime, fmtClock, liveClockSeconds, ordinal, esc, TZ };

/* ---------- editable content -----------------------------------
   Any element with data-cms="hero.title" has its text replaced by
   the matching row in site_content. Images use data-cms-src.
----------------------------------------------------------------*/
async function applyContent() {
  const { data } = await sb.from('site_content').select('key, value');
  if (!data) return;
  const map = Object.fromEntries(data.map(r => [r.key, r.value]));
  window.IVY_CONTENT = map;

  document.querySelectorAll('[data-cms]').forEach(el => {
    const v = map[el.dataset.cms];
    if (v != null && v !== '') el.innerHTML = esc(v).replace(/\n/g, '<br>');
  });
  document.querySelectorAll('[data-cms-src]').forEach(el => {
    const v = map[el.dataset.cmsSrc];
    if (v) el.src = v;
  });
  document.querySelectorAll('[data-cms-href]').forEach(el => {
    const v = map[el.dataset.cmsHref];
    if (v) el.href = v;
  });

  applyTheme(map);
}

/* ---------- section colours -------------------------------------
   Colours set in the admin "Pages" tab (kind: 'color') override the
   CSS variables in ivy.css on every page load, live, site-wide.
----------------------------------------------------------------*/
function applyTheme(map) {
  const VARS = {
    'theme.ivy':      '--ivy',
    'theme.ivy_deep': '--ivy-deep',
    'theme.brass':    '--brass',
    'theme.sprig':    '--ivy-sprig'
  };
  Object.entries(VARS).forEach(([key, cssVar]) => {
    if (map[key]) document.documentElement.style.setProperty(cssVar, map[key]);
  });
}

/* ---------- section photo galleries ------------------------------
   Any element with data-gallery="key" is filled with the images
   assigned to that section in the admin "Photos" tab, in order.
----------------------------------------------------------------*/
async function applyGalleries() {
  const nodes = document.querySelectorAll('[data-gallery]');
  if (!nodes.length) return;
  const sections = [...new Set([...nodes].map(el => el.dataset.gallery))];
  const { data } = await sb.from('gallery_images').select('*').in('section', sections).order('sort');
  nodes.forEach(el => {
    const imgs = (data || []).filter(g => g.section === el.dataset.gallery);
    if (imgs.length) {
      el.innerHTML = imgs.map(g =>
        `<img src="${esc(g.url)}" alt="${esc(g.alt ?? '')}" class="w-full h-48 object-cover rounded-md">`).join('');
      el.closest('section')?.classList.remove('hidden');
    }
  });
}

/* ---------- header / footer ---------- */
const NAV = [
  ['Home', 'index.html'],
  ['Schedule', 'schedule.html'],
  ['Standings', 'standings.html'],
  ['Teams', 'teams.html'],
  ['Live', 'live.html'],
  ['Register', 'register.html']
];

function chrome() {
  const here = location.pathname.split('/').pop() || 'index.html';
  const links = NAV.map(([label, href]) => {
    const on = href === here;
    return `<a href="${href}" class="px-3 py-2 text-sm font-semibold rounded-sm transition
      ${on ? 'text-white bg-white/15' : 'text-white/75 hover:text-white'}">${label}</a>`;
  }).join('');

  const header = document.getElementById('site-header');
  if (header) header.innerHTML = `
    <div class="crest-field text-white">
      <div class="shell flex items-center justify-between py-3">
        <a href="index.html" class="flex items-center gap-3">
          <img src="assets/img/logo.png" alt="Milton Ivy League crest" class="h-11 w-11 rounded-full">
          <span class="display text-lg leading-none">Milton<br>Ivy League</span>
        </a>
        <nav class="hidden md:flex items-center gap-1">${links}</nav>
        <div class="flex items-center gap-2">
          <a href="admin.html" class="hidden sm:inline-flex btn btn-ghost !py-2 !px-3 !text-xs">Staff</a>
          <button id="nav-toggle" class="md:hidden btn btn-ghost !py-2 !px-3" aria-expanded="false" aria-label="Open menu">Menu</button>
        </div>
      </div>
      <nav id="nav-mobile" class="md:hidden hidden shell pb-4 flex flex-col gap-1">
        ${NAV.map(([l, h]) => `<a href="${h}" class="py-2 text-white/85 border-b border-white/10">${l}</a>`).join('')}
        <a href="admin.html" class="py-2 text-white/85">Staff login</a>
      </nav>`;

  const t = document.getElementById('nav-toggle');
  if (t) t.addEventListener('click', () => {
    const m = document.getElementById('nav-mobile');
    m.classList.toggle('hidden');
    t.setAttribute('aria-expanded', String(!m.classList.contains('hidden')));
  });

  const footer = document.getElementById('site-footer');
  if (footer) footer.innerHTML = `
    <div class="crest-field text-white mt-24">
      <div class="shell py-14 grid gap-10 md:grid-cols-3">
        <div>
          <img src="assets/img/logo.png" alt="" class="h-14 w-14 rounded-full mb-4">
          <p class="serif text-white/80 text-lg" data-cms="footer.tagline">${esc(CFG.TAGLINE)}</p>
        </div>
        <div>
          <h3 class="display text-sm mb-3">Around the league</h3>
          <div class="flex flex-col gap-2 text-sm text-white/75">
            ${NAV.map(([l, h]) => `<a href="${h}" class="hover:text-white w-fit">${l}</a>`).join('')}
          </div>
        </div>
        <div>
          <h3 class="display text-sm mb-3">Get in touch</h3>
          <p class="text-sm text-white/75">${esc(CFG.VENUE)}<br>
            <a class="hover:text-white" href="mailto:${esc(CFG.CONTACT_EMAIL)}" data-cms="footer.email">${esc(CFG.CONTACT_EMAIL)}</a>
          </p>
          <p class="text-xs text-white/45 mt-6">© ${new Date().getFullYear()} Milton Ivy League</p>
        </div>
      </div>
    </div>`;
}

document.addEventListener('DOMContentLoaded', async () => {
  chrome();
  try { await applyContent(); } catch (e) { console.warn('Content load skipped:', e.message); }
  try { await applyGalleries(); } catch (e) { console.warn('Gallery load skipped:', e.message); }
  document.dispatchEvent(new CustomEvent('ivy:ready'));
});
