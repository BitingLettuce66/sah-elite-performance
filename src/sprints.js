/* SAH Elite Performance — sprint-time domain logic.
   The soul of the sprint niche: times at standard distances, PB per distance,
   and per-distance season progression. Lower time = faster = better.
   Backward-compatible with the early single-field log shape. */

export const SPRINT_DISTANCES = ['10m','20m','30m','20m fly','30m fly','60m','100m','150m','200m'];

// Normalize a log's sprint results to [{dist, time}], supporting the legacy
// single sprintDist/sprintTime shape so older logs still chart.
export function sprintResults(log){
  if(!log) return [];
  if(Array.isArray(log.sprints)){
    return log.sprints
      .filter(s => s && s.dist && s.time != null && s.time !== '' && !Number.isNaN(Number(s.time)))
      .map(s => ({ dist: s.dist, time: Number(s.time) }));
  }
  if(log.sprintTime != null && log.sprintTime !== '' && !Number.isNaN(Number(log.sprintTime))){
    const dist = (log.sprintDist != null && log.sprintDist !== '') ? `${log.sprintDist}m` : '—';
    return [{ dist, time: Number(log.sprintTime) }];
  }
  return [];
}

// Fastest time per distance across all logs: { [dist]: { time, date } }.
export function bestByDistance(sessions, logs){
  const best = {};
  for(const se of sessions){
    const lg = logs[se.id]; if(!lg) continue;
    for(const r of sprintResults(lg)){
      if(!best[r.dist] || r.time < best[r.dist].time) best[r.dist] = { time: r.time, date: se.date };
    }
  }
  return best;
}

// Time-series for one distance, chronological: [{ date, time }].
export function seriesForDistance(sessions, logs, dist){
  const pts = [];
  for(const se of [...sessions].sort((a,b)=>a.date.localeCompare(b.date))){
    const lg = logs[se.id]; if(!lg) continue;
    for(const r of sprintResults(lg)) if(r.dist === dist) pts.push({ date: se.date, time: r.time });
  }
  return pts;
}

// Distances that have any logged times, in canonical order (+ any non-standard).
export function loggedDistances(sessions, logs){
  const seen = new Set();
  for(const se of sessions){ const lg = logs[se.id]; if(!lg) continue;
    for(const r of sprintResults(lg)) seen.add(r.dist); }
  const ordered = SPRINT_DISTANCES.filter(d => seen.has(d));
  for(const d of seen) if(!ordered.includes(d)) ordered.push(d); // legacy/custom distances
  return ordered;
}
