import { createClient } from '@supabase/supabase-js';

// The publishable key is designed to be exposed in client-side code -- it has
// no privileges beyond what each table's RLS policy explicitly grants to the
// anon role (public read-only on every table in this project, plus execute on
// the two time-control RPCs). It is safe to commit, unlike the service-role
// key used by the backend Edge Functions, which never appears in this app.
const SUPABASE_URL = 'https://yesnnugnuxqwyjykmljk.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_6BwvxN3KfH-MuOHEqI9ccg_4o0JIH41';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
