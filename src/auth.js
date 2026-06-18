/* Phase 1 — magic-link (passwordless) auth.
   Local-first: a signed-out user gets the FULL offline app; signing in is the
   door to cloud sync (Phase 2), never a gate on using the app. All functions are
   safe no-ops when auth isn't configured. */
import { supabase, AUTH_ENABLED } from './supabase.js';

export { AUTH_ENABLED };

// Email the user a one-tap sign-in link. Returns true on send.
export async function sendMagicLink(email, redirectTo) {
  if (!AUTH_ENABLED) throw new Error('Auth is not configured.');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo || (location.origin + location.pathname) },
  });
  if (error) throw error;
  return true;
}

export async function getSession() {
  if (!AUTH_ENABLED) return null;
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

export async function getUser() {
  const s = await getSession();
  return s ? s.user : null;
}

export async function signOut() {
  if (AUTH_ENABLED) await supabase.auth.signOut();
}

// Subscribe to login/logout. Returns an unsubscribe fn.
export function onAuthChange(cb) {
  if (!AUTH_ENABLED) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}
