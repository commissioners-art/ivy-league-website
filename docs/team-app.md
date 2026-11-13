# Team portal → phone app

The team portal (`team.html`) is built so it can become a store app without a rewrite.

## Today: installable web app (PWA)
- `team.webmanifest` + `sw.js` make the portal installable. Android/Chrome shows an **Install** button in the portal; on iPhone players use Share → Add to Home Screen (the portal shows that hint).
- Opened from the home screen it runs full screen (`html.tp-app`): no website header/footer, notch-safe padding, bottom tab bar.
- On phones in the browser it already uses the bottom tab bar.

## How the code is split
| Layer | File | Reused by an app? |
|---|---|---|
| Rules and data | `supabase/team-portal.sql` (tables, RLS, `portal_*` functions) | Yes, unchanged. Every app talks to the same Supabase project. |
| Data API | `assets/js/team-api.js` (`createTeamApi`) | Yes. No DOM code; returns plain data, throws player-safe errors. Works in Node/React Native (`module.exports`) and accepts a custom `storage` (e.g. AsyncStorage) and `createClient`. |
| Screens | `team.html`, `assets/js/team.js`, `assets/css/team.css` | Capacitor: yes, as-is. React Native: rebuilt as native screens calling the same API. |

## Path to the App Store / Play Store
1. **Capacitor (fastest):** wrap the portal pages in a Capacitor shell, point it at `team.html`, ship to both stores. Add push notifications for new chat messages with `@capacitor/push-notifications` + a Supabase database webhook/edge function on `team_messages` inserts.
2. **React Native / Expo (most native feel):** `createTeamApi({ url, anonKey, storage: AsyncStorage, createClient })` from `team-api.js`, and build Chat / Schedule / Roster / Me screens. Supabase anonymous sign-in, RPCs and realtime all work the same.

Things an app will want next: push notifications for chat, and per-game In/Out availability (fits under Schedule).
For the subscription product, the same API gains a `league_id` (multi-tenancy) and the app picks the league at sign-in.
