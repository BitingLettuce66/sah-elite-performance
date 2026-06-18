/* Supabase client — Phase 1 (auth; sync follows in Phase 2).
   Config comes from Vite env: VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY.
   Both are SAFE-PUBLIC (protected by Row-Level Security) — they're meant to ship
   in the client. The service_role key must NEVER be here.

   If config is missing (e.g. a build with no env), the client is null and the
   app runs fully local-only — auth/sync just stay off. */
import { createClient } from '@supabase/supabase-js';

const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;
const configured = !!(URL && ANON) && !/PASTE_/.test(`${URL}${ANON}`);

export const supabase = configured ? createClient(URL, ANON) : null;
export const AUTH_ENABLED = configured;
