/* SAH Elite Performance — app entry (Vite module).
   Generic engine: renders whatever sessions are in the plan data (App-Spec §10.1).
   Logs persist in IndexedDB via db.js — the only storage layer (§10.7). On
   completion a session's prescription is snapshotted into its log so later plan
   edits never rewrite trained history (§10.4). Records carry athleteId/planId for
   a future multi-athlete coaching hub (§10.6); the UI stays single-user for now. */

import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { loadAllLogs, putLog, deleteLog, migrateFromLocalStorage, getSetting, putSetting, ATHLETE_ID, PLAN_ID } from './db.js';
import { drawProgressCharts, destroyCharts } from './charts.js';
import { drawCard, saveCanvas, shareCanvas } from './share.js';
import { SPRINT_DISTANCES, sprintResults, bestByDistance, loggedDistances, seriesForDistance } from './sprints.js';
import { initSync, getStatus, fullSync, onStatusChange } from './sync.js';
import { addDays, sortByDate, findToday as findTodaySession, computeStreak, statusOf } from './logic.js';
import { TYPE, NIGGLE, todayISO, round, esc, slug, fmtDate, monthLabel, pill } from './format.js';
import { buildBackup, validateBackup, normalizeImported } from './backup.js';
import { loadPlan } from './plan-validator.js';
import { AUTH_ENABLED, sendMagicLink, getUser, signOut, onAuthChange } from './auth.js';

const $ = (s, el = document) => el.querySelector(s);

// Lightweight toast (used for the PWA update prompt + offline-ready notice).
function showToast(msg, actionLabel, onAction, autoHide){
  let el = $('#toast');
  if(!el){ el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.innerHTML = `<span>${msg}</span>` + (actionLabel ? `<button id="toast-act">${actionLabel}</button>` : '');
  el.classList.add('show');
  if(actionLabel && onAction) $('#toast-act').onclick = onAction;
  if(autoHide) setTimeout(()=>el.classList.remove('show'), autoHide);
}
// Prompt to refresh when a new version is deployed (instead of a silent reload).
const updateSW = registerSW({
  onNeedRefresh(){ showToast('New version available', 'Refresh', ()=>updateSW(true)); },
  onOfflineReady(){ showToast('Ready to use offline', null, null, 2600); },
});
// state.logs is an in-memory cache of all logs, loaded once from IndexedDB on
// boot so render code can read them synchronously.
const state = { data: null, view: 'today', logs: {}, share: { type: 'session', size: 'story' },
  sprintDist: null, targets: {}, assignment: null, bodyweight: [],
  histView: 'calendar', histMonth: null, user: null };
const targetsKey = () => `targets:${ATHLETE_ID}`;
// Presentation helpers (TYPE, NIGGLE, todayISO, round, esc, slug, fmtDate,
// monthLabel, pill) live in format.js; addDays + status logic live in logic.js.
// Bind the relative template to the calendar: session.date = assignment start + offset.
// Leaves any session that already has a date (legacy seed) untouched.
function materializeDates(){
  const start = (state.assignment && state.assignment.startDate) || (state.data && state.data.startDate);
  if(!start) return;
  for(const se of state.data.sessions) if(typeof se.offsetDays==='number') se.date = addDays(start, se.offsetDays);
}
// Read from the in-memory cache (synchronous, as render code expects).
const getLog = id => state.logs[id] || null;

// Freeze a session's prescription as it was trained (App-Spec §10.4).
function snapshotOf(se){
  return { focus:se.focus, type:se.type, surface:se.surface,
    sprint:se.sprint, gym:se.gym, warmup:se.warmup, cooldown:se.cooldown };
}
// How a session should be shown: its frozen snapshot if the log has one,
// otherwise the live plan. History uses this so past sessions stay as trained.
function sessionView(se){
  const lg = getLog(se.id);
  return (lg && lg.prescribedSnapshot) ? { ...se, ...lg.prescribedSnapshot } : se;
}
// Update the cache instantly, then write through to IndexedDB (fire-and-forget).
// Merges onto the previous record (preserving the snapshot + ids), stamps the
// athlete/plan, and snapshots the prescription the first time it's marked done.
function setLog(id, v) {
  const prev = state.logs[id] || {};
  const log = { ...prev, ...v, sessionId: id, athleteId: ATHLETE_ID, planId: PLAN_ID };
  if (v.done && !log.prescribedSnapshot) {
    const se = byId(id);
    if (se) log.prescribedSnapshot = snapshotOf(se);
  }
  state.logs[id] = log;
  putLog(log).catch(e => console.error('Log save failed', e));
}
// Remove a log from the cache and IndexedDB.
function delLog(id){
  delete state.logs[id];
  deleteLog(id).catch(e => console.error('Log delete failed', e));
}
// One-tap completion: mark done without opening the full sheet.
function quickDone(id){ const se=byId(id); setLog(id, { done:true, date: se?se.date:todayISO() }); render(); }
// Toggle a session's done state from a History row (keeps other log fields).
function toggleDone(id){ const lg=getLog(id)||{}; const se=byId(id); setLog(id, { done:!lg.done, date: se?se.date:todayISO() }); render(); }

// --- Backup: export/import logs as JSON (local data can be cleared by iOS) ---
// Pure serialise/validate/normalise live in backup.js; here we wire them to
// the file download, IndexedDB writes, and the in-memory cache.
function exportBackup(){
  const data = buildBackup(Object.values(state.logs),
    { athleteId:ATHLETE_ID, planId:PLAN_ID, exportedAt:new Date().toISOString() });
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = `sah-backup-${todayISO()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
function applyBackup(logs){
  const recs = normalizeImported(logs, { athleteId:ATHLETE_ID, planId:PLAN_ID });
  for(const rec of recs){
    state.logs[rec.sessionId] = rec;
    putLog(rec).catch(e=>console.error('Import write failed', e));
  }
  return recs.length;
}
function importNotice(title, body){
  openSheet(`<h3>${esc(title)}</h3><p class="sheet-note">${esc(body)}</p>
    <div class="sheet-actions"><button class="btn-save" id="x-ok">OK</button></div>`);
  $('#x-ok').onclick = closeSheet;
}
async function importBackup(file){
  let data;
  try { data = JSON.parse(await file.text()); }
  catch(e){ return importNotice('Import failed', "That file isn't valid JSON."); }
  const v = validateBackup(data);
  if(!v.ok) return importNotice('Import failed', v.error);
  const existing = Object.keys(state.logs).length;
  const finish = () => { const n=applyBackup(v.logs); render();
    importNotice('Backup restored', `Imported ${n} logged session${n===1?'':'s'}.`); };
  if(existing > 0){
    // Confirm before overwriting existing data.
    openSheet(`<h3>Import backup?</h3>
      <p class="sheet-note">This merges <b>${v.logs.length}</b> session${v.logs.length===1?'':'s'} from the file into your <b>${existing}</b> existing log${existing===1?'':'s'}. Entries for the same session are overwritten, and this can't be undone.</p>
      <div class="sheet-actions"><button class="btn-cancel" id="x-cancel">Cancel</button><button class="btn-save" id="x-go">Import</button></div>`);
    $('#x-cancel').onclick = closeSheet;
    $('#x-go').onclick = finish;
  } else finish();
}

// --- Plan loading: every plan (bundled seed or imported file) enters through the
//     validator. loadPlan() (plan-validator.js) is pure; here we add the IO. ---
const planKey = () => 'plan:' + ATHLETE_ID;
// Reserve multi-tenant identity on a plan; default if absent (App-Spec §10.6).
function withPlanIdentity(data){
  data.athleteId = data.athleteId || ATHLETE_ID;
  data.planId = data.planId || PLAN_ID;
  return data;
}
// Validate a flat plan at the load boundary. On success use the normalized,
// engine-ready data; if the bundled seed itself ever fails validation, fall back
// to the raw seed so the app still renders (and shout in the console).
function validatedPlanOrRaw(raw, label){
  const r = loadPlan(raw);
  if(r.ok){ if(r.warnings.length) console.info(`Plan "${label}" loaded with ${r.warnings.length} warning(s).`, r.warnings); return r.data; }
  console.error(`Plan "${label}" failed validation — loading it unvalidated so the app still works.`, r.errors);
  return raw;
}
// Import a plan JSON: reject (with reasons) anything that fails the validator,
// otherwise confirm, persist, and swap it in. Logged history is kept (keyed by
// session id); the start date / assignment is left as-is.
async function importPlan(file){
  let raw;
  try { raw = JSON.parse(await file.text()); }
  catch(e){ return importNotice('Import failed', "That file isn't valid JSON."); }
  const r = loadPlan(raw);
  if(!r.ok){
    const items = r.errors.slice(0,8).map(e=>`<li>${esc(e.message)}</li>`).join('');
    const more = r.errors.length>8 ? `<p class="sheet-note">…and ${r.errors.length-8} more.</p>` : '';
    openSheet(`<h3>Plan rejected</h3>
      <p class="sheet-note">This plan didn’t pass the safety checks, so it was not loaded:</p>
      <ul class="sheet-errs">${items}</ul>${more}
      <div class="sheet-actions"><button class="btn-save" id="x-ok">OK</button></div>`);
    $('#x-ok').onclick = closeSheet;
    return;
  }
  const data = withPlanIdentity(r.data);
  const warnMsg = r.warnings.length ? ` (${r.warnings.length} warning${r.warnings.length===1?'':'s'})` : '';
  // Anchor the new programme to a chosen start date — default to the plan's own
  // startDate (validated already) or today. Without this, sessions are scheduled
  // off the OLD assignment date and a fresh plan can land entirely in the past.
  const startDefault = data.startDate || todayISO();
  const finish = async () => {
    const startVal = $('#imp-start').value || startDefault;
    closeSheet();
    state.data = data;
    state.assignment = { athleteId:ATHLETE_ID, planId:data.planId, templateId:data.templateId||'default',
      startDate:startVal, planVersion:data.planVersion||1, status:'active' };
    try {
      await putSetting(planKey(), data);
      await putSetting('assignment:'+ATHLETE_ID, state.assignment);
    } catch(e){ console.error('Saving imported plan failed', e); }
    materializeDates(); render();
    importNotice('Plan imported', `Loaded ${data.sessions.length} session${data.sessions.length===1?'':'s'}${warnMsg}. Starts ${fmtDate(startVal)}.`);
  };
  openSheet(`<h3>Import plan?</h3>
    <p class="sheet-note">This replaces your current programme with <b>${esc(data.name||'an imported plan')}</b> — ${data.sessions.length} session${data.sessions.length===1?'':'s'}. Your logged history is kept (matched by session id).</p>
    <div class="field"><label for="imp-start">Start date</label><input id="imp-start" type="date" value="${startDefault}"></div>
    <div class="sheet-actions"><button class="btn-cancel" id="x-cancel">Cancel</button><button class="btn-save" id="x-go">Import</button></div>`);
  $('#x-cancel').onclick = closeSheet;
  $('#x-go').onclick = finish;
}

async function boot(){
  let raw;
  try { const r = await fetch('./data/seed.json'); raw = await r.json(); }
  catch(e){ $('#view').innerHTML = '<div class="empty">Could not load programme data.</div>'; return; }
  // The bundled seed enters through the same validator gate as any other plan.
  state.data = withPlanIdentity(validatedPlanOrRaw(raw, 'seed'));
  // The template is date-agnostic; an assignment binds it to a start date.
  const defaultAssignment = { athleteId:ATHLETE_ID, planId:state.data.planId,
    templateId:state.data.templateId||'default', startDate:state.data.startDate,
    planVersion:state.data.planVersion||1, status:'active' };
  state.assignment = defaultAssignment;
  // Ask the browser to keep our data (reduces the chance iOS evicts it under pressure).
  try { if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{}); } catch(e){}
  state.storageOk = true;
  try {
    const moved = await migrateFromLocalStorage();
    if (moved) console.info(`Imported ${moved} log(s) from localStorage into IndexedDB.`);
    state.logs = await loadAllLogs(state.data.athleteId);
    state.targets = (await getSetting(targetsKey())) || {};
    state.bodyweight = (await getSetting('bw:'+ATHLETE_ID)) || [];
    // Prefer a previously-imported plan, re-validated on load; keep the seed if it
    // is absent or (defensively) no longer passes.
    const storedPlan = await getSetting(planKey());
    if(storedPlan){
      const rp = loadPlan(storedPlan);
      if(rp.ok) state.data = withPlanIdentity(rp.data);
      else console.warn('Stored plan failed validation; keeping the bundled seed.', rp.errors);
    }
    let asg = await getSetting('assignment:'+ATHLETE_ID);
    if(!asg){ asg = defaultAssignment; await putSetting('assignment:'+ATHLETE_ID, asg); }
    state.assignment = asg;
  } catch(e){
    // App still works read-only on the programme; just can't save this session.
    state.storageOk = false;
    console.warn('Storage unavailable — logs will not persist this session.', e);
  }
  materializeDates();   // compute session.date from the active assignment
  initSync();           // no-op while disabled; cloud sync slots in here later
  if(AUTH_ENABLED){     // Phase 1: restore session + react to login/logout (sync stays off until Phase 2)
    try { state.user = await getUser(); } catch(e){ state.user = null; }
    onAuthChange(session => { state.user = session ? session.user : null; render(); });
  }
  document.querySelectorAll('#tabbar button').forEach(b => b.onclick = () => { if(b.dataset.view==='history') state._scrollHistory=true; state.view=b.dataset.view; sync(); render(); });
  const sb=$('#avatar-btn'); if(sb) sb.onclick=openSettings;
  sync(); render();
  if(!state.storageOk) showToast('Storage is unavailable — anything you log won’t be saved this session.', null, null, 6000);
  else await checkReturn();   // first-run welcome or welcome-back (no-op otherwise)
}
function sync(){ document.querySelectorAll('#tabbar button').forEach(b => { const on=b.dataset.view===state.view; b.classList.toggle('active', on); if(on) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); }); }

const sorted = () => sortByDate(state.data.sessions);
function findToday(){ return findTodaySession(state.data.sessions, todayISO()); }
function byId(id){ return state.data.sessions.find(x=>x.id===id); }

function card(se){
  const lg = getLog(se.id)||{};
  const done = lg.done ? '<span class="done">✓ Logged</span>' : '';
  const body = se.type==='RECOVERY'
    ? `<div class="callout rest"><b>Rest</b> — ${esc(se.sprint)}</div>`
    : `<div class="callout sprint"><span class="co-h">Sprint</span>${esc(se.sprint)}</div>` +
      (se.gym && se.gym!=='—' ? `<div class="callout gym"><span class="co-h">Gym</span>${esc(se.gym)}</div>` : '');
  const tog = se.warmup ? `
    <details><summary>Warm-up</summary><p>${esc(se.warmup)}</p></details>
    <details><summary>Cool-down</summary><p>${esc(se.cooldown)}</p></details>` : '';
  const rules = (state.data && state.data.rules && state.data.rules.length)
    ? `<details class="rules-tog"><summary>Session rules &amp; cues</summary><ul>${state.data.rules.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>` : '';
  return `<article class="card">
    <div class="card-top">${pill(se.type)}<span>${esc(se.phase)} · Wk ${se.week} · ${se.day}</span>${done}</div>
    <h2 class="card-title">${esc(se.focus)}</h2>
    <div class="meta">${fmtDate(se.date)} · ${esc(se.surface)}</div>
    ${body}${tog}${rules}
    ${lg.done
      ? `<button class="btn-log" data-id="${se.id}">Edit log</button>`
      : `<div class="card-actions"><button class="btn-done" data-id="${se.id}">✓ Mark done</button><button class="btn-log alt" data-id="${se.id}">Details</button></div>`}
  </article>`;
}

// The 7 sessions of a session's programme week (Mon–Sun).
function weekSessions(se){ return sorted().filter(s=>s.phase===se.phase && s.week===se.week); }
// Next session strictly after today (for the "up next" line).
function nextAfter(){ const t=todayISO(); return sorted().find(s=>s.date>t) || null; }
function weekStrip(se){
  const t=todayISO();
  const cells = weekSessions(se).map(s=>{ const lg=getLog(s.id)||{}; const d=statusDot(s,lg);
    return `<button class="wk-cell ${d.cls}${s.date===t?' today':''}" data-id="${s.id}">
      <span class="wk-day">${s.day}</span><span class="wk-dot">${d.char}</span></button>`;
  }).join('');
  return `<div class="week-strip">${cells}</div>`;
}
function viewToday(){
  const se = findToday();
  if(!se) return '<div class="empty">Programme complete 🏆</div>';
  const isToday = se.date===todayISO();
  const next = isToday ? nextAfter() : null;
  const nextHtml = next ? `<button class="nextup" data-id="${next.id}">
      <span class="nextup-label">Up next</span>
      <span class="nextup-body">${pill(next.type)}<span class="nextup-focus">${esc(next.focus)}</span><span class="nextup-date">${fmtDate(next.date)}</span></span></button>` : '';
  return `<p class="eyebrow">${isToday?'Today':'Next up'}</p>${weekStrip(se)}${card(se)}${nextHtml}`;
}
// Tappable status dot: done ✓ / missed (past, not done) / upcoming.
function statusDot(se, lg){
  const cls = statusOf(se, lg||{}, todayISO());
  return { cls, char: cls==='done' ? '✓' : '○' };
}
// Calendar / List toggle (+ a "jump to today" link in list mode).
function historyHead(active){
  return `<div class="hist-head">
    <div class="hist-toggle">
      <button data-hview="calendar" class="${active==='calendar'?'sel':''}">Calendar</button>
      <button data-hview="list" class="${active==='list'?'sel':''}">List</button>
    </div>
    ${active==='list'?`<button class="link-btn" id="hist-today">Today</button>`:''}
  </div>`;
}
function viewHistory(){
  return state.histView==='list' ? viewHistoryList() : viewHistoryCalendar();
}
function viewHistoryList(){
  const t = todayISO();
  let lastMonth = '';
  const rows = sorted().map(se => {
    const lg=getLog(se.id)||{}; const sv=sessionView(se); const d=statusDot(se,lg);
    const ml = monthLabel(se.date);
    const head = ml!==lastMonth ? (lastMonth=ml, `<div class="month-head">${ml}</div>`) : '';
    const isToday = se.date===t ? ' is-today' : '';
    return `${head}<div class="row${isToday}">
      <button class="row-main" data-id="${se.id}"><span class="row-date">${fmtDate(se.date)}</span>${pill(sv.type)}<span class="row-focus">${esc(sv.focus)}</span></button>
      <button class="row-dot ${d.cls}" data-done="${se.id}" aria-label="toggle done">${d.char}</button>
    </div>`;
  }).join('');
  return `${historyHead('list')}<div class="list">${rows}</div>`;
}
// The month currently shown in the calendar ('YYYY-MM'), defaulting to today's.
const calMonth = () => state.histMonth || todayISO().slice(0,7);
function shiftMonth(ym, delta){ const [y,m]=ym.split('-').map(Number); const d=new Date(y, m-1+delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
// Map each session to its (computed) date for O(1) calendar lookup.
function sessionsByDate(){ const m={}; for(const s of state.data.sessions) m[s.date]=s; return m; }
function viewHistoryCalendar(){
  const ym = calMonth(); const [y,m] = ym.split('-').map(Number);
  const t = todayISO();
  const byDate = sessionsByDate();
  const startWeekday = (new Date(y, m-1, 1).getDay()+6)%7;   // 0=Mon … 6=Sun
  const daysInMonth = new Date(y, m, 0).getDate();
  const dow = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<span class="cal-dow">${d}</span>`).join('');
  let cells = '';
  for(let i=0;i<startWeekday;i++) cells += `<span class="cal-cell empty"></span>`;
  for(let d=1; d<=daysInMonth; d++){
    const iso = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const se = byDate[iso];
    const isToday = iso===t ? ' today' : '';
    if(!se){ cells += `<span class="cal-cell${isToday}"><span class="cal-num">${d}</span></span>`; continue; }
    const st = statusOf(se, getLog(se.id)||{}, t);   // done | missed | future
    const stWord = st==='done' ? 'done' : st==='missed' ? 'missed' : 'upcoming';   // status in words, not colour alone
    cells += `<button class="cal-cell has ${st}${isToday}" data-id="${se.id}" aria-label="${fmtDate(iso)} — ${esc(se.focus)} — ${stWord}">
      <span class="cal-num">${d}</span><span class="cal-dot ${st}" aria-hidden="true"></span></button>`;
  }
  const label = new Date(y, m-1, 1).toLocaleDateString('en-AU',{month:'long',year:'numeric'});
  return `${historyHead('calendar')}
    <div class="cal-nav">
      <button class="cal-arrow" id="cal-prev" aria-label="Previous month">‹</button>
      <span class="cal-month">${label}</span>
      <button class="cal-arrow" id="cal-next" aria-label="Next month">›</button>
    </div>
    <div class="cal-grid cal-head">${dow}</div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-legend">
      <span><i class="cal-dot done"></i>Done</span>
      <span><i class="cal-dot missed"></i>Missed</span>
      <span><i class="cal-dot future"></i>Upcoming</span>
    </div>`;
}
function streak(){ return computeStreak(state.data.sessions, state.logs, todayISO()); }
// Next deload / taper / race / test-gate on or after today.
function nextCheckpoint(){
  const t=todayISO();
  const isCp = s => ['DELOAD','TAPER','RACE'].includes(s.type) || /test|gate/i.test(s.focus||'');
  const cp = sorted().find(s => s.date>=t && isCp(s));
  if(!cp) return null;
  const days = Math.round((new Date(cp.date+'T00:00') - new Date(t+'T00:00'))/86400000);
  return { ...cp, days };
}
function chartCard(title,unit,key){
  return `<section class="chart-card"><h3>${title}<span>${unit}</span></h3>
    <div class="chart-wrap" id="wrap-${key}"><canvas id="ch-${key}"></canvas></div></section>`;
}
function viewProgress(){
  const done = state.data.sessions.filter(s=>(getLog(s.id)||{}).done).length;
  const cp = nextCheckpoint();
  const when = cp ? (cp.days<=0?'today':`in ${cp.days} day${cp.days===1?'':'s'}`) : '';
  const cpHtml = cp ? `<div class="checkpoint">
      <span class="ck-eyebrow">Next checkpoint</span>
      <div class="ck-row">${pill(cp.type)}<b>${esc(cp.focus)}</b></div>
      <span class="ck-meta">${fmtDate(cp.date)} · ${when}</span>
    </div>` : '';
  return `<p class="eyebrow">Progress</p>
   <div class="stats">
     <div class="stat"><b>${done}</b><span>sessions logged</span></div>
     <div class="stat"><b>${streak()}</b><span>day streak</span></div>
   </div>
   ${cpHtml}
   ${chartCard('Squat load','kg','squat')}
   ${chartCard('Hip thrust','kg','hip')}
   ${sprintPBsCard()}
   ${sprintProgressCard()}
   ${chartCard('Readiness','/10','readiness')}
   ${bwCard()}
   ${chartCard('Adherence','sessions','adh')}`;
}
// Sprint PBs — fastest time per distance, with optional target.
function sprintPBsCard(){
  const best = bestByDistance(state.data.sessions, state.logs);
  const dists = SPRINT_DISTANCES.filter(d=>best[d]);
  for(const d in best) if(!dists.includes(d)) dists.push(d); // legacy/custom distances
  const body = dists.length
    ? `<div class="pb-grid">${dists.map(d=>{ const b=best[d]; const tgt=state.targets[d];
        return `<div class="pb"><span class="pb-dist">${esc(d)}</span><b class="pb-time">${b.time.toFixed(2)}<small>s</small></b>${tgt!=null&&tgt!==''?`<span class="pb-target">goal ${Number(tgt).toFixed(2)}s</span>`:''}</div>`;
      }).join('')}</div>`
    : `<p class="card-note">Log sprint times below to see your best per distance.</p>`;
  return `<section class="chart-card"><h3>Sprint PBs<button class="link-btn" id="pb-targets">Set targets</button></h3>${body}</section>`;
}
// Sprint progression — one distance over time, with distance chips to switch.
function sprintProgressCard(){
  const dists = loggedDistances(state.data.sessions, state.logs);
  const sel = (state.sprintDist && dists.includes(state.sprintDist)) ? state.sprintDist : (dists[0]||null);
  state.sprintDist = sel;
  const chips = dists.length>1
    ? `<div class="dist-chips">${dists.map(d=>`<button class="chip ${d===sel?'sel':''}" data-dist="${esc(d)}">${esc(d)}</button>`).join('')}</div>` : '';
  return `<section class="chart-card"><h3>Sprint progression<span>${sel?esc(sel):'sec'}</span></h3>
    ${chips}<div class="chart-wrap" id="wrap-sprint"><canvas id="ch-sprint"></canvas></div></section>`;
}
// Bodyweight card (a periodic metric, not per-session) + quick-log.
function bwCard(){
  return `<section class="chart-card"><h3>Bodyweight<button class="link-btn" id="bw-log">Log weight</button></h3>
    <div class="chart-wrap" id="wrap-bw"><canvas id="ch-bw"></canvas></div></section>`;
}
function openBodyweight(){
  openSheet(`<h3>Log bodyweight</h3>
    <div class="field"><label>Date</label><input id="bw-date" type="date" value="${todayISO()}"></div>
    <div class="field"><label>Weight (kg)</label><input id="bw-kg" type="number" step="0.1" inputmode="decimal" placeholder="kg"></div>
    <div class="sheet-actions"><button class="btn-cancel" id="x-cancel">Cancel</button><button class="btn-save" id="x-save">Save</button></div>`);
  $('#x-cancel').onclick=closeSheet;
  $('#x-save').onclick=async ()=>{ const date=$('#bw-date').value; const kg=round(Number($('#bw-kg').value),2);
    if(date && kg){ const arr=(state.bodyweight||[]).filter(e=>e.date!==date); arr.push({date,kg});
      arr.sort((a,b)=>a.date.localeCompare(b.date)); state.bodyweight=arr;
      try{ await putSetting('bw:'+ATHLETE_ID, arr); }catch(e){ console.error('Saving bodyweight failed', e); } }
    closeSheet(); render(); };
}
// Per-distance season target times (optional), persisted via db.js.
function openTargets(){
  const t = state.targets || {};
  openSheet(`<h3>Season targets</h3><p class="sheet-note">Optional goal time per distance — shown on your PBs and the progression chart.</p>
    ${SPRINT_DISTANCES.map(d=>`<div class="field tg-row"><label>${esc(d)}</label><input id="tg-${slug(d)}" type="number" step="0.01" inputmode="decimal" placeholder="sec" value="${t[d]??''}"></div>`).join('')}
    <div class="sheet-actions"><button class="btn-cancel" id="x-cancel">Cancel</button><button class="btn-save" id="x-save">Save targets</button></div>`);
  $('#x-cancel').onclick=closeSheet;
  $('#x-save').onclick=async ()=>{
    const out={}; for(const d of SPRINT_DISTANCES){ const v=$('#tg-'+slug(d)).value.trim(); if(v!=='') out[d]=Number(v); }
    state.targets=out; try{ await putSetting(targetsKey(), out); }catch(e){ console.error('Saving targets failed', e); }
    closeSheet(); render();
  };
}

// One editable sprint-time row (distance + seconds) for the log sheet.
function sprintRowHTML(r={}){
  return `<div class="sprint-row">
    <select class="sr-dist">${SPRINT_DISTANCES.map(d=>`<option ${r.dist===d?'selected':''}>${d}</option>`).join('')}</select>
    <input class="sr-time" type="number" step="0.01" inputmode="decimal" placeholder="sec" value="${r.time??''}">
    <button type="button" class="sr-del" aria-label="Remove">×</button>
  </div>`;
}

// On boot, greet the user appropriately: a brand-new install gets a one-time
// welcome (openWelcome); a user returning after a gap gets a "welcome back"
// prompt (openWelcomeBack). Last-seen is stamped each visit so the gap is
// measured from the last actual open. Needs storage to remember the flags.
const ONBOARDED_KEY = () => 'onboarded:'+ATHLETE_ID;
const LAST_SEEN_KEY = () => 'lastSeen:'+ATHLETE_ID;
const RETURN_GAP_DAYS = 4;   // a gap at least this long triggers "welcome back"
const daysBetween = (a, b) => Math.round((new Date(b+'T00:00') - new Date(a+'T00:00')) / 86400000);
async function checkReturn(){
  if(!state.storageOk) return;
  let onboarded, lastSeen;
  try { onboarded = await getSetting(ONBOARDED_KEY()); lastSeen = await getSetting(LAST_SEEN_KEY()); }
  catch(e){ return; }
  putSetting(LAST_SEEN_KEY(), todayISO()).catch(()=>{});   // stamp this visit for next time
  if(!onboarded){
    if(Object.keys(state.logs).length){ putSetting(ONBOARDED_KEY(), true).catch(()=>{}); return; }  // existing data — mark seen silently
    openWelcome(); return;
  }
  if(lastSeen){ const gap = daysBetween(lastSeen, todayISO()); if(gap >= RETURN_GAP_DAYS) openWelcomeBack(gap); }
}
// Returning after a gap: pick up today, re-anchor the plan, or review misses.
function openWelcomeBack(gap){
  openSheet(`<h3>Welcome back 👋</h3>
    <p class="sheet-note">It's been about ${gap} days. Jump back into today's session, re-anchor your plan to start fresh from now, or review what you missed.</p>
    <div class="wb-actions">
      <button class="btn-save" id="wb-continue">Continue training</button>
      <button class="btn-cancel" id="wb-restart">Adjust plan start</button>
      <button class="link-btn" id="wb-missed">See what I missed</button>
    </div>`);
  $('#wb-continue').onclick = () => { state.view='today'; closeSheet(); sync(); render(); };
  $('#wb-restart').onclick = openPlanStart;
  $('#wb-missed').onclick = () => { state.view='history'; state.histView='calendar'; closeSheet(); sync(); render(); };
}
function openWelcome(){
  const cur = state.assignment ? state.assignment.startDate : state.data.startDate;
  openSheet(`<h3>Welcome 👋</h3>
    <p class="sheet-note">This is your training log — pre-loaded with your full programme. It works completely offline, and everything stays on this device.</p>
    <p class="sheet-note">Your programme starts on the date below. Change it if you'd like a different start day — you can always adjust it later in Settings.</p>
    <div class="field"><label>Start date</label><input id="ob-start" type="date" value="${cur}"></div>
    <div class="sheet-actions"><button class="btn-save" id="ob-go">Start training</button></div>`);
  $('#ob-go').onclick = async () => {
    const v = $('#ob-start').value;
    if(v && v!==cur){ state.assignment = { ...state.assignment, startDate:v };
      try{ await putSetting('assignment:'+ATHLETE_ID, state.assignment); }catch(e){ console.error('Saving start failed', e); }
      materializeDates(); }
    try{ await putSetting(ONBOARDED_KEY(), true); }catch(e){}
    closeSheet(); render();
  };
}

// Relative "x ago" for the last-synced line.
function timeAgo(iso){
  if(!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime())/1000));
  if(s < 60) return 'just now';
  const m = Math.round(s/60); if(m < 60) return `${m} min ago`;
  const h = Math.round(m/60); if(h < 24) return `${h} hr ago`;
  const d = Math.round(h/24); return `${d} day${d===1?'':'s'} ago`;
}
// Cloud-sync status for the Account section → { cls, text }. Reflects offline,
// syncing, error, and idle (with last-synced time + pending count).
function syncStatusLine(){
  const s = getStatus();
  if(typeof navigator!=='undefined' && navigator.onLine===false)
    return { cls:'sync-off', text:'Offline — changes will sync when you reconnect.' };
  if(s.state==='syncing') return { cls:'sync-go', text:'Syncing…' };
  if(s.state==='error') return { cls:'sync-err', text:'Sync issue — will retry. Tap “Sync now” to try again.' };
  if(s.state==='idle'){
    const when = s.lastSyncAt ? ` · ${timeAgo(s.lastSyncAt)}` : '';
    const pend = s.pending ? ` · ${s.pending} pending` : '';
    return { cls:'sync-ok', text:`Synced${when}${pend}` };
  }
  return { cls:'sync-off', text:'Your training will sync once you’re online.' };
}
// Refresh the status line + Sync-now button in place (driven by onStatusChange).
function refreshSyncStatus(){
  const el = $('#set-sync-status'); if(!el) return;
  const st = syncStatusLine(); el.className = `sync-status ${st.cls}`; el.textContent = st.text;
  const sn = $('#set-syncnow'); if(sn){ const busy = getStatus().state==='syncing'; sn.disabled = busy; sn.textContent = busy?'Syncing…':'Sync now'; }
}
// Account section of Settings (Phase 1 auth). Empty when auth isn't configured.
function accountGroup(){
  if(!AUTH_ENABLED) return '';
  if(state.user){
    const st = syncStatusLine();
    return `<section class="set-group">
      <h4>Account</h4>
      <p class="set-note">Signed in as <b>${esc(state.user.email||'your account')}</b>.</p>
      <p class="sync-status ${st.cls}" id="set-sync-status">${st.text}</p>
      <div class="backup-actions">
        <button class="btn-cancel" id="set-syncnow">Sync now</button>
        <button class="btn-cancel" id="set-signout">Sign out</button>
      </div>
    </section>`;
  }
  return `<section class="set-group">
    <h4>Account</h4>
    <p class="set-note">Sign in to sync your training across devices and back it up. The app works fully offline either way — signing in only adds sync.</p>
    <button class="btn-cancel" id="set-signin">Sign in to sync</button>
  </section>`;
}
// Magic-link (passwordless) sign-in sheet.
function openSignIn(){
  openSheet(`<h3>Sign in</h3><p class="sheet-note">Enter your email and we'll send a one-tap sign-in link — no password.</p>
    <div class="field"><label>Email</label><input id="auth-email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com"></div>
    <div class="sheet-actions"><button class="btn-cancel" id="x-cancel">Cancel</button><button class="btn-save" id="x-send">Send link</button></div>`);
  $('#x-cancel').onclick=closeSheet;
  $('#x-send').onclick=async ()=>{
    const email=$('#auth-email').value.trim(); if(!email) return;
    const btn=$('#x-send'); btn.textContent='Sending…'; btn.disabled=true;
    try {
      await sendMagicLink(email);
      openSheet(`<h3>Check your email</h3><p class="sheet-note">A sign-in link is on its way to <b>${esc(email)}</b>. Open it on this device to finish.</p>
        <div class="sheet-actions"><button class="btn-save" id="x-ok">OK</button></div>`);
      $('#x-ok').onclick=closeSheet;
    } catch(e){
      openSheet(`<h3>Couldn't send the link</h3><p class="sheet-note">${esc(e.message||'Something went wrong. Check the email and try again.')}</p>
        <div class="sheet-actions"><button class="btn-save" id="x-ok">OK</button></div>`);
      $('#x-ok').onclick=closeSheet;
    }
  };
}

// Settings home — account + plan + data controls, reachable from the top-bar
// avatar so they don't clutter the Progress dashboard.
function openSettings(){
  openSheet(`<h3>Settings</h3>
    ${accountGroup()}
    <section class="set-group">
      <h4>Plan</h4>
      <p class="set-note">Programme starts <b>${state.assignment?fmtDate(state.assignment.startDate):'—'}</b> · ${state.data.sessions.length} sessions, scheduled relative to that date.</p>
      <div class="backup-actions">
        <button class="btn-cancel" id="set-plan-start">Change start date</button>
        <button class="btn-cancel" id="set-plan-import">Import plan</button>
      </div>
      <input type="file" id="set-plan-file" accept="application/json,.json" hidden>
    </section>
    <section class="set-group">
      <h4>Your data</h4>
      <p class="set-note">Logs live only on this device. Export a backup regularly — iOS can clear local storage if the app sits unused.</p>
      <div class="backup-actions">
        <button class="btn-cancel" id="set-export">Export backup</button>
        <button class="btn-cancel" id="set-import">Import backup</button>
      </div>
      <input type="file" id="set-file" accept="application/json,.json" hidden>
    </section>
    <div class="sheet-actions"><button class="btn-save" id="x-done">Done</button></div>`);
  $('#x-done').onclick = closeSheet;
  $('#set-plan-start').onclick = openPlanStart;
  const pi=$('#set-plan-import'), pf=$('#set-plan-file');
  if(pi&&pf){ pi.onclick=()=>pf.click(); pf.onchange=()=>{ if(pf.files[0]) importPlan(pf.files[0]); pf.value=''; }; }
  $('#set-export').onclick = exportBackup;
  const im=$('#set-import'), f=$('#set-file');
  if(im&&f){ im.onclick=()=>f.click(); f.onchange=()=>{ if(f.files[0]) importBackup(f.files[0]); f.value=''; }; }
  const si=$('#set-signin'); if(si) si.onclick=openSignIn;
  const so=$('#set-signout'); if(so) so.onclick=async ()=>{ await signOut(); state.user=null; openSettings(); render(); };
  const sn=$('#set-syncnow');
  if(sn) sn.onclick=async ()=>{ sn.disabled=true; sn.textContent='Syncing…'; try{ await fullSync(); }catch(e){} refreshSyncStatus(); };
  // Live-update the status line while Settings is open; cleaned up on close.
  if($('#set-sync-status')){
    if(state._syncStatusOff) state._syncStatusOff();
    state._syncStatusOff = onStatusChange(()=>refreshSyncStatus());
  }
}

// Change the plan's start date — shifts the whole schedule (the assignment),
// while logs stay attached to their sessions by id.
function openPlanStart(){
  const cur = state.assignment ? state.assignment.startDate : state.data.startDate;
  openSheet(`<h3>Plan start date</h3><p class="sheet-note">Shifts the whole programme to begin on this date. Your logs stay attached to their sessions.</p>
    <div class="field"><label>Start date</label><input id="f-start" type="date" value="${cur}"></div>
    <div class="sheet-actions"><button class="btn-cancel" id="x-cancel">Cancel</button><button class="btn-save" id="x-save">Save</button></div>`);
  $('#x-cancel').onclick=closeSheet;
  $('#x-save').onclick=async ()=>{ const v=$('#f-start').value;
    if(v){ state.assignment={ ...state.assignment, startDate:v };
      try{ await putSetting('assignment:'+ATHLETE_ID, state.assignment); }catch(e){ console.error('Saving plan start failed', e); }
      materializeDates(); }
    closeSheet(); render(); };
}

// Most recent completed session on/before today (for the "Session" card).
function lastCompleted(){
  return sorted().filter(s=>s.date<=todayISO()).reverse().find(s=>(getLog(s.id)||{}).done) || null;
}
// Headline PR from logged numbers: best squat → hip thrust → fastest sprint.
function bestPR(){
  let squat=null, hip=null;
  for(const s of state.data.sessions){ const lg=getLog(s.id); if(!lg) continue;
    if(lg.squatKg!=null) squat = Math.max(squat??-Infinity, lg.squatKg);
    if(lg.hipThrustKg!=null) hip = Math.max(hip??-Infinity, lg.hipThrustKg);
  }
  if(squat!=null && isFinite(squat)) return {value:squat,unit:'kg',label:'Back Squat'};
  if(hip!=null && isFinite(hip)) return {value:hip,unit:'kg',label:'Hip Thrust'};
  const best = bestByDistance(state.data.sessions, state.logs);
  for(const d of SPRINT_DISTANCES) if(best[d]) return {value:best[d].time.toFixed(2),unit:'s',label:`${d} PB`};
  return null;
}
function weekRecap(){
  const se=findToday()||sorted().slice(-1)[0];
  const inWk = state.data.sessions.filter(s=>s.phase===se.phase && s.week===se.week);
  return { phase:se.phase, week:se.week, done:inWk.filter(s=>(getLog(s.id)||{}).done).length, total:inWk.length, streak:streak() };
}
// Pick a metric with enough data to chart for the "Progress" share card.
function seriesField(field){ const pts=[]; for(const s of sorted()){ const lg=getLog(s.id);
  if(lg && lg[field]!=null && lg[field]!=='') pts.push({date:s.date, v:Number(lg[field])}); } return pts; }
function progressSeries(){
  const sq=seriesField('squatKg'); if(sq.length>=2) return {title:'Squat load',unit:'kg',points:sq};
  const hip=seriesField('hipThrustKg'); if(hip.length>=2) return {title:'Hip thrust',unit:'kg',points:hip};
  const bw=(state.bodyweight||[]).slice().sort((a,b)=>a.date.localeCompare(b.date)).map(p=>({date:p.date,v:p.kg}));
  if(bw.length>=2) return {title:'Bodyweight',unit:'kg',points:bw};
  for(const d of loggedDistances(state.data.sessions, state.logs)){
    const sp=seriesForDistance(state.data.sessions, state.logs, d).map(p=>({date:p.date,v:p.time}));
    if(sp.length>=2) return {title:`Sprint ${d}`,unit:'s',points:sp};
  }
  return null;
}
function shareData(type){
  if(type==='pr') return { pr:bestPR(), footer:fmtDate(todayISO()) };
  if(type==='recap') return { ...weekRecap(), footer:fmtDate(todayISO()) };
  if(type==='progress') return { ...(progressSeries()||{}), footer:fmtDate(todayISO()) };
  const se=lastCompleted()||findToday(); const lg=se?getLog(se.id):null;
  return { done:!!(lg&&lg.done), focus:se?se.focus:'—', phase:se?se.phase:'', week:se?se.week:'',
    day:se?se.day:'', surface:se?se.surface:'', sprint:se?se.sprint:'', gym:se?se.gym:'',
    metric:(lg&&lg.squatKg!=null)?{value:lg.squatKg,unit:'kg',label:'Squat'}:null,
    footer:se?fmtDate(se.date):'' };
}
function shareFilename(){ return `sah-${state.share.type}-${todayISO()}.png`; }

function viewShare(){
  const t=state.share.type, sz=state.share.size;
  const tbtn=(v,l)=>`<button data-stype="${v}" class="${t===v?'sel':''}">${l}</button>`;
  const sbtn=(v,l)=>`<button data-ssize="${v}" class="${sz===v?'sel':''}">${l}</button>`;
  return `<p class="eyebrow">Share</p>
   <div class="seg share-pick">${tbtn('session','Session')}${tbtn('pr','PR')}${tbtn('recap','Recap')}${tbtn('progress','Progress')}</div>
   <div class="seg share-pick">${sbtn('story','Story 9:16')}${sbtn('feed','Feed 1:1')}</div>
   <div class="share-preview"><canvas id="share-canvas"></canvas></div>
   <div class="sheet-actions">
     <button class="btn-cancel" id="share-save">Save image</button>
     <button class="btn-save" id="share-do">Share</button>
   </div>`;
}

function render(){
  destroyCharts();               // tear down any live charts before replacing the DOM
  const tb=$('#topbar'); if(tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight+'px');
  const v=state.view;
  const vEl=$('#view');
  vEl.innerHTML = v==='today'?viewToday():v==='history'?viewHistory():v==='progress'?viewProgress():viewShare();
  vEl.classList.remove('fade'); void vEl.offsetWidth; vEl.classList.add('fade');   // restart enter animation
  const se=findToday(); $('#phase').textContent = se?`${se.phase} · Wk ${se.week}`:'';
  $('#view').querySelectorAll('.btn-log').forEach(b=>b.onclick=()=>openLog(b.dataset.id));
  $('#view').querySelectorAll('.btn-done').forEach(b=>b.onclick=()=>quickDone(b.dataset.id));
  $('#view').querySelectorAll('.row-main').forEach(b=>b.onclick=()=>openDetail(b.dataset.id));
  $('#view').querySelectorAll('.row-dot').forEach(b=>b.onclick=()=>toggleDone(b.dataset.done));
  $('#view').querySelectorAll('.wk-cell, .nextup').forEach(b=>b.onclick=()=>openDetail(b.dataset.id));
  if(v==='history'){
    $('#view').querySelectorAll('.hist-toggle button[data-hview]').forEach(b=>b.onclick=()=>{
      state.histView=b.dataset.hview; if(b.dataset.hview==='list') state._scrollHistory=true; render(); });
    if(state.histView==='calendar'){
      const prev=$('#cal-prev'); if(prev) prev.onclick=()=>{ state.histMonth=shiftMonth(calMonth(),-1); render(); };
      const next=$('#cal-next'); if(next) next.onclick=()=>{ state.histMonth=shiftMonth(calMonth(),+1); render(); };
      $('#view').querySelectorAll('.cal-cell.has').forEach(c=>c.onclick=()=>openDetail(c.dataset.id));
    } else {
      const scrollToToday=()=>{ const r=$('#view .row.is-today'); if(r) r.scrollIntoView({block:'center'}); };
      const tbtn=$('#hist-today'); if(tbtn) tbtn.onclick=scrollToToday;
      if(state._scrollHistory){ state._scrollHistory=false; requestAnimationFrame(scrollToToday); }
    }
  }
  if(v==='progress'){
    drawProgressCharts(state.data.sessions, state.logs,
      { sprintDist: state.sprintDist, sprintTarget: state.targets[state.sprintDist], bodyweight: state.bodyweight });
    $('#view').querySelectorAll('.chip[data-dist]').forEach(c=>c.onclick=()=>{ state.sprintDist=c.dataset.dist; render(); });
    const tg=$('#pb-targets'); if(tg) tg.onclick=openTargets;
    const bwl=$('#bw-log'); if(bwl) bwl.onclick=openBodyweight;
  }
  if(v==='share'){
    const cv=$('#share-canvas');
    drawCard(cv, state.share.type, state.share.size, shareData(state.share.type));
    $('#view').querySelectorAll('[data-stype]').forEach(b=>b.onclick=()=>{ state.share.type=b.dataset.stype; render(); });
    $('#view').querySelectorAll('[data-ssize]').forEach(b=>b.onclick=()=>{ state.share.size=b.dataset.ssize; render(); });
    $('#share-save').onclick=()=>saveCanvas(cv, shareFilename());
    $('#share-do').onclick=()=>shareCanvas(cv, shareFilename());
  }
}

function openDetail(id){ openSheet(card(sessionView(byId(id))));
  $('#sheet').querySelectorAll('.btn-log').forEach(b=>b.onclick=()=>openLog(b.dataset.id));
  $('#sheet').querySelectorAll('.btn-done').forEach(b=>b.onclick=()=>{ quickDone(b.dataset.id); closeSheet(); }); }

function openLog(id){
  const se=byId(id); const existing=getLog(id); const lg=existing||{done:false,rpe:null,sleep:null,readiness:null,niggle:'None',note:''};
  const seg=(name,val,max)=>`<div class="seg" data-seg="${name}">`+Array.from({length:max},(_,i)=>i+1).map(n=>`<button data-v="${n}" class="${val==n?'sel':''}">${n}</button>`).join('')+`</div>`;
  openSheet(`<h3>${esc(se.focus)} · ${se.day}</h3>
    <div class="field"><label>Done?</label><div class="seg" data-seg="done"><button data-v="1" class="${lg.done?'sel':''}">Yes</button><button data-v="0" class="${!lg.done?'sel':''}">No</button></div></div>
    <div class="field"><label>RPE (1–10)</label>${seg('rpe',lg.rpe,10)}</div>
    <details class="log-more"${(lg.sleep||lg.readiness||(lg.niggle&&lg.niggle!=='None'))?' open':''}><summary>Readiness &amp; wellness</summary>
      <div class="field"><label>Sleep /10</label>${seg('sleep',lg.sleep,10)}</div>
      <div class="field"><label>Readiness /10</label>${seg('readiness',lg.readiness,10)}</div>
      <div class="field"><label>Niggle</label><select id="f-niggle">${NIGGLE.map(o=>`<option ${lg.niggle===o?'selected':''}>${o}</option>`).join('')}</select></div>
    </details>
    <div class="field"><label>Gym loads — optional (feeds Progress charts)</label>
      <div class="nums">
        <input id="f-squat" type="number" inputmode="decimal" step="0.5" placeholder="Squat kg" value="${lg.squatKg??''}">
        <input id="f-hip" type="number" inputmode="decimal" step="0.5" placeholder="Hip thrust kg" value="${lg.hipThrustKg??''}">
      </div></div>
    <div class="field"><label>Sprint times — optional (distance + seconds)</label>
      <div id="sprint-rows"></div>
      <button type="button" class="link-btn" id="add-sprint">+ Add a time</button></div>
    <div class="field"><label>Note</label><textarea id="f-note" rows="3" placeholder="actuals, times, how it felt">${esc(lg.note)}</textarea></div>
    <div class="sheet-actions"><button class="btn-cancel" id="x-cancel">Cancel</button><button class="btn-save" id="x-save">Save</button></div>
    ${existing ? `<button class="btn-delete" id="x-delete">Delete log</button>` : ''}`);
  const sheet=$('#sheet'); const picks={done:lg.done?1:0,rpe:lg.rpe,sleep:lg.sleep,readiness:lg.readiness};
  sheet.querySelectorAll('.seg').forEach(seg=>{ const key=seg.dataset.seg;
    seg.querySelectorAll('button').forEach(btn=>btn.onclick=()=>{ picks[key]=Number(btn.dataset.v);
      seg.querySelectorAll('button').forEach(x=>x.classList.remove('sel')); btn.classList.add('sel'); }); });
  $('#x-cancel').onclick=closeSheet;
  // Sprint-time rows: prefill from the log (or one blank row), add/remove dynamically.
  const rowsEl = $('#sprint-rows');
  const existingSprints = sprintResults(lg);
  rowsEl.innerHTML = (existingSprints.length ? existingSprints : [{}]).map(sprintRowHTML).join('');
  $('#add-sprint').onclick = () => rowsEl.insertAdjacentHTML('beforeend', sprintRowHTML());
  rowsEl.onclick = e => { if(e.target.classList.contains('sr-del')) e.target.closest('.sprint-row').remove(); };
  const collectSprints = () => Array.from(rowsEl.querySelectorAll('.sprint-row')).map(row=>{
    const dist=row.querySelector('.sr-dist').value; const t=row.querySelector('.sr-time').value.trim();
    return t==='' ? null : { dist, time:round(Number(t),2) };
  }).filter(Boolean);
  const num = sel => { const v=$(sel).value.trim(); return v===''?null:round(Number(v),2); };
  $('#x-save').onclick=()=>{ setLog(id,{done:picks.done===1,rpe:picks.rpe,sleep:picks.sleep,readiness:picks.readiness,
      niggle:$('#f-niggle').value,
      squatKg:num('#f-squat'),hipThrustKg:num('#f-hip'),sprints:collectSprints(),
      note:$('#f-note').value,date:se.date}); closeSheet(); render(); };
  if(existing){ const del=$('#x-delete'); let armed=false;
    del.onclick=()=>{ if(!armed){ armed=true; del.textContent='Tap again to delete'; del.classList.add('armed'); return; }
      delLog(id); closeSheet(); render(); }; }
}

// --- Modal/sheet: focus management + keyboard (Escape to close, Tab trapped) ---
let _lastFocus = null;   // element to restore focus to when the sheet closes
let _sheetKeys = null;   // active keydown handler while a sheet is open
// Visible, enabled, focusable elements inside a container, in DOM order.
function focusablesIn(el){
  return [...el.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
    .filter(n => !n.disabled && n.offsetParent !== null);
}
function openSheet(html){
  _lastFocus = document.activeElement;       // remember what to return focus to
  const sheet = $('#sheet'); sheet.innerHTML = html;
  // a11y: name the dialog by its heading, and link each field label to its control.
  const heading = sheet.querySelector('h3');
  if(heading){ if(!heading.id) heading.id = 'sheet-title'; sheet.setAttribute('aria-labelledby', heading.id); }
  else sheet.removeAttribute('aria-labelledby');
  sheet.querySelectorAll('.field').forEach((fld,i)=>{
    const lab = fld.querySelector('label'); const ctl = fld.querySelector('input,select,textarea');
    if(lab && ctl){ if(!ctl.id) ctl.id = `fld-${i}`; lab.htmlFor = ctl.id; }
  });
  $('#modal').classList.remove('hidden');
  const items = focusablesIn(sheet);
  (items[0] || sheet).focus();               // move focus into the dialog
  _sheetKeys = e => {
    if(e.key === 'Escape'){ e.preventDefault(); closeSheet(); return; }
    if(e.key !== 'Tab') return;
    const f = focusablesIn(sheet); if(!f.length) return;
    const first = f[0], last = f[f.length-1];
    if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', _sheetKeys);
}
function closeSheet(){
  $('#modal').classList.add('hidden');
  if(_sheetKeys){ document.removeEventListener('keydown', _sheetKeys); _sheetKeys = null; }
  if(state._syncStatusOff){ state._syncStatusOff(); state._syncStatusOff = null; }  // stop live sync-status updates
  if(_lastFocus && _lastFocus.focus){ try{ _lastFocus.focus(); }catch(e){} }
  _lastFocus = null;
}
$('#modal').addEventListener('click',e=>{ if(e.target.id==='modal') closeSheet(); });

boot();
