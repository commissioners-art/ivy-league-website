# Milton Ivy League — website

Static site on GitHub Pages, data and auth in Supabase, payments through Stripe links,
and Conrad the concierge running on a Supabase Edge Function.

```
index.html          Home — live/next game, this week, leaders, news
schedule.html       Full season schedule with division/team filters
standings.html      Standings table + scoring leaders
teams.html          Rosters, auto-filled from approved registrations
register.html       Player form -> Supabase, then Stripe payment link
live.html           Public live scoreboard (realtime, running clock)
admin.html          Staff portal (login + scorekeeping + CMS)
404.html            Not-found page
CNAME               Your custom domain — edit this
assets/css/ivy.css  Design tokens and components
assets/js/config.js  ← the only file you must edit
assets/js/app.js     Shared: header, footer, editable content, date helpers
assets/js/conrad.js  Conrad chat widget
assets/js/admin.js   Staff portal logic
supabase/schema.sql              Run this once in the SQL editor
supabase/functions/conrad/index.ts  Deploy this for Conrad
```

---

## 1. Set up Supabase (15 minutes)

1. Create a free project at supabase.com. Note the **Project URL** and the
   **anon public** key from *Project Settings → API*.
2. Open *SQL Editor*, paste the whole of `supabase/schema.sql`, and run it. That creates
   every table, the security rules, the standings and stats views, and turns on realtime.
3. Go to *Storage* and create a **public** bucket named `media`. This is where admin image
   uploads land.
4. Create your first staff login: *Authentication → Users → Add user*, with an email and
   password. Then in the SQL editor run:

   ```sql
   insert into staff (id, email, full_name, role)
   select id, email, 'Your Name', 'admin' from auth.users where email = 'you@example.com';
   ```

   Repeat for each scorekeeper, using `'scorekeeper'` as the role. Scorekeepers can only
   run game sheets; admins see everything.
5. Paste your URL and anon key into `assets/js/config.js`.

The anon key is meant to be public. Row level security is what protects the data: anyone
can read the schedule, only signed-in staff can change a score, only admins can edit pages.

## 2. Deploy Conrad

Conrad needs an Anthropic API key, and a key can never live in a static site — so it runs
in an Edge Function instead.

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase secrets set ANTHROPIC_API_KEY=sk-ant-your-key
supabase functions deploy conrad --no-verify-jwt
```

Conrad is handed the current date and time, the next 25 games with scores and venues, the
team list, and the live registration prices each time someone writes to him, so his answers
about "when do I play next" stay correct without you touching anything. His manners,
refusals and tone live in the `SYSTEM` string at the top of
`supabase/functions/conrad/index.ts` — edit that text to change how he behaves.

If you skip this step the rest of the site works fine; Conrad simply falls back to pointing
people at the schedule and registration pages.

## 3. Push to GitHub

```bash
cd ivy-league
git init
git add .
git commit -m "Ivy League site"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

## 4. Turn on GitHub Pages

1. Repo → **Settings → Pages**.
2. Source: *Deploy from a branch*. Branch: `main`, folder: `/ (root)`. Save.
3. Wait a minute, then your site is at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

## 5. Move the domain off Webflow

Do this **last**, once the GitHub Pages URL looks right. Until you change DNS, the old
Webflow site stays live and nobody sees a thing.

**A day ahead:** in your registrar's DNS panel, drop the TTL on the existing records to
5 minutes (300 seconds). That way the switch takes minutes instead of hours.

**Cutover, in this order:**

1. Edit `CNAME` in this repo so it contains only your domain — `www.miltonivyleague.ca` —
   then commit and push.
2. In GitHub: *Settings → Pages → Custom domain*, enter the same domain and save.
3. In your registrar's DNS, **delete the Webflow records**:
   - the A records on `@` pointing at `75.2.70.75` and `99.83.190.102`
   - the CNAME on `www` pointing at `proxy-ssl.webflow.com`
   - (leave the `_webflow` TXT record or remove it — it does nothing either way)
   Leave every **MX** and email-related TXT record exactly as they are, or league email stops.
4. Add the GitHub records:
   - CNAME, host `www` → `YOUR-USERNAME.github.io`
   - A records on `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
     `185.199.111.153`
5. Wait. `www.miltonivyleague.ca` usually resolves within 10–30 minutes.
6. Back in *Settings → Pages*, tick **Enforce HTTPS** once the certificate is issued. It can
   take up to an hour and the box is greyed out until then — that is normal.
7. Cancel or downgrade the Webflow site plan only after the new site has been live for a few
   days, in case you want to roll back.

**Rolling back**, if something is wrong: put the two Webflow A records and the
`proxy-ssl.webflow.com` CNAME back and republish in Webflow. With a 300-second TTL you are
back inside five minutes.

## 5b. DNS reference

1. Edit `CNAME` so it contains only your domain, e.g. `www.miltonivyleague.ca`.
2. At your registrar, add a **CNAME** record: host `www` → `YOUR-USERNAME.github.io`.
3. For the bare domain, add four **A** records pointing at `185.199.108.153`,
   `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.
4. In *Settings → Pages*, enter the domain under *Custom domain* and tick
   **Enforce HTTPS** once the certificate is issued (up to an hour).

DNS can take a few hours to propagate. Keep the old site live until the new one resolves.

---

## Running the league day to day

**Adding a scorekeeper.** Create the user in Supabase Auth, then insert their row in
`staff` with role `scorekeeper`.

**Building the schedule.** *Schedule* tab. Pick away, home, date and time, division and
venue, then **Add game**. If you play a fixed weekly ice slot, set *Repeat weekly* to the
number of weeks and it creates the whole block in one go. Every field in the table below is
editable in place and saves the moment you change it — move a game, swap a team, fix a
score, mark one postponed. **Game sheet** on any row opens that game's scorekeeping screen,
and **Delete** removes the game along with any goals and penalties recorded on it.

**Running a game.** Scorekeeper signs in at `/admin.html` → *Scorekeeping* → picks the
game → **Start game (go live)**. Score buttons, the period clock, goals with two assists,
and penalties all write straight to the public scoreboard. The clock stores the time
remaining plus the moment it was last touched, so every spectator's browser ticks in sync
without hammering the database. **Finalize game** locks it and updates the standings.

**Registrations.** Everything submitted lands in *Registrations* — one table, sortable,
with a CSV export. Assign a team and set the status to **approved**: a database trigger
creates the player and they appear on the Teams page. Changing their team or number later
updates the roster too. Mark payment `paid` once Stripe confirms.

**Editing the site.** *Pages* lists every editable headline, paragraph and image on the
public site as a plain form. Change the words, hit **Save changes**, done. To make a new
piece of text editable, put `data-cms="some.key"` on the element in the HTML and add a row:

```sql
insert into site_content (key, value, label, kind, sort)
values ('about.title', 'Hockey for every level', 'About heading', 'text', 5);
```

Images work the same with `data-cms-src`, links with `data-cms-href`.

**Payment links.** *Payments* holds your Stripe links. Create the link in Stripe, paste the
URL with a label and price, and it shows on the registration page. Untick *Active* to retire
one after the season closes.

---

## Design notes

The palette is taken from the crest: `#09522B` ivy green with `#052E19` for large fields,
a soft vine tint `#7FA98E` for quiet detail, and a single warm accent — brass `#C08A2B` —
for the things that should be pressed. Brass appears on one button per screen and nowhere
else, which is what keeps it feeling deliberate.

Type is Archivo (variable width — headlines run wide and heavy, tables stay narrow and
tabular) with Newsreader for anything that reads like editorial. Numbers are tabular
everywhere so scores don't jitter as they change.

## Troubleshooting

- **Nothing loads and the console says "Invalid API key"** — `config.js` still has the
  placeholder values.
- **Data shows publicly but staff edits fail** — the signed-in user has no row in `staff`.
- **Scores don't update live** — confirm step 2 of the schema ran the
  `alter publication supabase_realtime` lines, and that *Database → Replication* lists
  `games` and `game_events`.
- **Conrad says he can't reach the records** — the Edge Function isn't deployed, or the
  `ANTHROPIC_API_KEY` secret is missing.
- **Custom domain shows a 404** — the `CNAME` file must contain the domain and nothing else.
