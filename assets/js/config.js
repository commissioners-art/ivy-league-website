/* ---------------------------------------------------------------
   Milton Ivy League — site configuration
   This is the ONLY file you must edit before going live.
   The anon key is safe to expose publicly: row level security
   in Supabase is what actually protects your data.
--------------------------------------------------------------- */
window.IVY_CONFIG = {
  SUPABASE_URL: 'https://azguekurdqthlxbksmez.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF6Z3Vla3VyZHF0aGx4YmtzbWV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5MTc4OTIsImV4cCI6MjEwNTQ5Mzg5Mn0.Ie8Zh7HYTXclKWKl7UH5M82XwahCjAdfFd6AwGIn-ho',

  // Name of the Supabase Edge Function that powers Conrad.
  CONRAD_FUNCTION: 'conrad',

  // Fallback values used before the database loads (or if it is unreachable).
  LEAGUE_NAME: 'Milton Ivy League',
  TAGLINE: 'Where pucks meet pints in Milton',
  VENUE: 'Milton Sports Centre',
  CONTACT_EMAIL: 'info@miltonivyleague.ca',
  TIMEZONE: 'America/Toronto'
};
