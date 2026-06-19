/* SAH Elite Performance — backup serialise/validate (pure).
   The JSON export/import is the on-device safety net and the future migration
   bridge (App-Spec §10.8). The DOM/download/storage glue stays in main.js;
   these pure functions carry the logic so they can be unit-tested. */

export const BACKUP_TYPE = 'sah-backup';

// The export payload for a set of logs.
export function buildBackup(logs, { athleteId, planId, exportedAt }) {
  return { app:'SAH Elite Performance', type:BACKUP_TYPE, version:1,
    athleteId, planId, exportedAt, logs };
}

// Validate a parsed backup: accept a {logs:[...]} object or a bare array;
// keep only well-formed entries (object with a string sessionId).
export function validateBackup(data) {
  const raw = Array.isArray(data) ? data : (data && Array.isArray(data.logs) ? data.logs : null);
  if(!raw) return { ok:false, error:"That file isn't a SAH backup — no logs found." };
  const logs = raw.filter(l => l && typeof l==='object' && typeof l.sessionId==='string');
  if(!logs.length) return { ok:false, error:'No valid log entries were found in that file.' };
  return { ok:true, logs };
}

// Stamp imported logs with the current athlete/plan, preserving each sessionId.
export function normalizeImported(logs, { athleteId, planId }) {
  return logs.map(lg => ({ athleteId, planId, ...lg, sessionId: lg.sessionId }));
}
