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
  // Keep well-formed entries; drop tombstones so a deleted session can't be
  // resurrected (and desync the cache from IndexedDB) on import.
  const logs = raw.filter(l => l && typeof l==='object' && typeof l.sessionId==='string' && l.deleted!==true);
  if(!logs.length) return { ok:false, error:'No valid log entries were found in that file.' };
  return { ok:true, logs };
}

// Stamp imported logs with athlete/plan and SANITISE to known fields + types, so
// a hand-edited or hostile file can't smuggle markup or NaN into what we later
// render. A log's own athleteId/planId still wins over the defaults.
const finiteNum = n => typeof n === 'number' && Number.isFinite(n);
export function normalizeImported(logs, { athleteId, planId }) {
  return logs.map(lg => {
    const rec = {
      athleteId: typeof lg.athleteId === 'string' ? lg.athleteId : athleteId,
      planId: typeof lg.planId === 'string' ? lg.planId : planId,
      sessionId: lg.sessionId,
    };
    if (typeof lg.done === 'boolean') rec.done = lg.done;
    for (const k of ['rpe', 'sleep', 'readiness', 'squatKg', 'hipThrustKg']) if (finiteNum(lg[k])) rec[k] = lg[k];
    if (typeof lg.niggle === 'string') rec.niggle = lg.niggle;
    if (typeof lg.note === 'string') rec.note = lg.note;
    if (typeof lg.date === 'string') rec.date = lg.date;
    if (Array.isArray(lg.sprints)) rec.sprints = lg.sprints
      .filter(s => s && typeof s === 'object' && finiteNum(s.time))
      .map(s => ({ dist: String(s.dist ?? ''), time: s.time }));
    if (lg.prescribedSnapshot && typeof lg.prescribedSnapshot === 'object' && !Array.isArray(lg.prescribedSnapshot)) rec.prescribedSnapshot = lg.prescribedSnapshot;
    return rec;
  });
}
