/* ---------------------------------------------------------------
   Milton Ivy League — site configuration
   This is the ONLY file you must edit before going live.
   The anon key is safe to expose publicly: row level security
   in Supabase is what actually protects your data.
--------------------------------------------------------------- */
window.IVY_CONFIG = {
  SUPABASE_URL: 'https://azguekurdqthlxbksmez.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF6Z3Vla3VyZHF0aGx4YmtzbWV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5MTc4OTIsImV4cCI6MjEwNTQ5Mzg5Mn0.Ie8Zh7HYTXclKWKl7UH5M82XwahCjAdfFd6AwGIn-ho',

  // Fallback values used before the database loads (or if it is unreachable).
  LEAGUE_NAME: 'Milton Ivy League',
  TAGLINE: 'Where pucks meet pints in Milton',
  VENUE: 'Milton Sports Centre',
  CONTACT_EMAIL: 'info@miltonivyleague.ca',
  TIMEZONE: 'America/Toronto',

  // Live game time is estimated from the scheduled start (no clock to run).
  // A game is GAME_MINUTES long, split evenly into PERIODS periods.
  GAME_MINUTES: 60,
  PERIODS: 3
};
