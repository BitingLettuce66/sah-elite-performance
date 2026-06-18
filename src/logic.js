/* SAH Elite Performance — pure programme logic.
   No DOM, no state, no storage — just functions of their inputs, so they can be
   unit-tested and reused. main.js wraps these with app state. */

// Calendar-day arithmetic on YYYY-MM-DD (local, DST-safe).
export function addDays(iso, n){
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// Sessions sorted ascending by their (computed) date. Non-mutating.
export function sortByDate(sessions){
  return [...sessions].sort((a, b) => a.date.localeCompare(b.date));
}

// Today's session if dated today, else the next upcoming one, else null.
export function findToday(sessions, today){
  return sessions.find(s => s.date === today) || sortByDate(sessions).find(s => s.date >= today) || null;
}

// Consecutive completed sessions counting back from today (inclusive).
export function computeStreak(sessions, logs, today){
  const past = sortByDate(sessions).filter(s => s.date <= today).reverse();
  let n = 0;
  for (const s of past){ if (logs[s.id] && logs[s.id].done) n++; else break; }
  return n;
}

// A session's status relative to today: 'done' | 'missed' | 'future'.
export function statusOf(session, log, today){
  if (log && log.done) return 'done';
  if (session.date < today) return 'missed';
  return 'future';
}
