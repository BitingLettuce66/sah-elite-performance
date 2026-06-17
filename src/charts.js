/* SAH Elite Performance — Progress charts (Chart.js).
   Reads numeric fields from logs and draws the priority charts:
   squat load, hip-thrust load, sprint times, adherence.
   Each chart shows an intentional empty state before data exists. */

import { Chart, registerables } from 'chart.js';
import { seriesForDistance } from './sprints.js';
Chart.register(...registerables);

const C = {
  accent: '#7FB2D9', silver: '#C9CBD1', muted: '#8A8A90',
  grid: 'rgba(255,255,255,.06)', surface: '#1C1C20', text: '#ECEAE3',
};

// Dark, minimal defaults to match the Quiet-Luxury theme.
Chart.defaults.color = C.muted;
Chart.defaults.font.family =
  "-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',Roboto,sans-serif";
Chart.defaults.font.size = 11;

const fmtDate = iso => new Date(iso + 'T00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

// Live chart instances, destroyed before each redraw / when leaving the view.
let instances = [];
export function destroyCharts() {
  instances.forEach(c => { try { c.destroy(); } catch (e) {} });
  instances = [];
}

// Collect [{date, v}] for sessions that have a numeric value in `field`.
function valueSeries(sessions, logs, field) {
  const pts = [];
  for (const s of sessions) {
    const lg = logs[s.id];
    const v = lg && lg[field];
    if (v != null && v !== '' && !Number.isNaN(Number(v))) pts.push({ date: s.date, v: Number(v) });
  }
  return pts;
}

function emptyState(wrapId, msg) {
  const wrap = document.getElementById(wrapId);
  if (wrap) wrap.innerHTML = `<p class="chart-empty">${msg}</p>`;
}

function baseOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'nearest', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: C.surface, borderColor: 'rgba(255,255,255,.12)', borderWidth: 1,
        titleColor: C.text, bodyColor: C.text, padding: 10, displayColors: false,
      },
    },
    scales: {
      x: { grid: { color: C.grid }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } },
      y: { grid: { color: C.grid }, ticks: { maxTicksLimit: 5 } },
    },
  };
}

// A simple themed line chart for a load metric (kg etc.).
function lineChart(canvasId, wrapId, pts, { color, empty, unit }) {
  if (!pts.length) return emptyState(wrapId, empty);
  const el = document.getElementById(canvasId);
  if (!el) return;
  instances.push(new Chart(el, {
    type: 'line',
    data: {
      labels: pts.map(p => fmtDate(p.date)),
      datasets: [{
        data: pts.map(p => p.v),
        borderColor: color, backgroundColor: color + '22',
        borderWidth: 2, tension: 0.3, fill: true,
        pointRadius: 3, pointBackgroundColor: color,
      }],
    },
    options: { ...baseOpts(), plugins: { ...baseOpts().plugins,
      tooltip: { ...baseOpts().plugins.tooltip,
        callbacks: { label: ctx => `${ctx.parsed.y} ${unit || ''}`.trim() } } } },
  }));
}

// Sprint progression for ONE distance over the season (lower is faster).
// Draws an optional dashed target line when a goal time is set.
function sprintChart(sessions, logs, opts = {}) {
  const dist = opts.sprintDist;
  if (!dist) return emptyState('wrap-sprint', 'Log a sprint time to start this chart.');
  const pts = seriesForDistance(sessions, logs, dist);
  if (!pts.length) return emptyState('wrap-sprint', `No ${dist} times logged yet.`);
  const el = document.getElementById('ch-sprint');
  if (!el) return;
  const datasets = [{
    label: dist,
    data: pts.map(p => p.time),
    borderColor: C.accent, backgroundColor: C.accent + '22',
    borderWidth: 2, tension: 0.3, fill: true,
    pointRadius: 3, pointBackgroundColor: C.accent,
  }];
  const target = Number(opts.sprintTarget);
  if (!Number.isNaN(target) && opts.sprintTarget != null && opts.sprintTarget !== '') {
    datasets.push({
      label: 'Target', data: pts.map(() => target),
      borderColor: C.silver, borderWidth: 1.5, borderDash: [6, 5],
      pointRadius: 0, fill: false,
    });
  }
  instances.push(new Chart(el, {
    type: 'line',
    data: { labels: pts.map(p => fmtDate(p.date)), datasets },
    options: { ...baseOpts(), plugins: { ...baseOpts().plugins,
      tooltip: { ...baseOpts().plugins.tooltip,
        callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y}s` } } } },
  }));
}

// Adherence: cumulative completed sessions over time — momentum at a glance.
function adherenceChart(sessions, logs) {
  let total = 0;
  const pts = [];
  for (const s of sessions) {
    if (logs[s.id] && logs[s.id].done) { total += 1; pts.push({ date: s.date, v: total }); }
  }
  if (!pts.length) return emptyState('wrap-adh', 'Mark sessions done and your adherence builds here.');
  const el = document.getElementById('ch-adh');
  if (!el) return;
  instances.push(new Chart(el, {
    type: 'line',
    data: {
      labels: pts.map(p => fmtDate(p.date)),
      datasets: [{
        data: pts.map(p => p.v),
        borderColor: '#5DAE7E', backgroundColor: '#5DAE7E22',
        borderWidth: 2, tension: 0.2, fill: true, stepped: false,
        pointRadius: 0,
      }],
    },
    options: { ...baseOpts(), plugins: { ...baseOpts().plugins,
      tooltip: { ...baseOpts().plugins.tooltip,
        callbacks: { label: ctx => `${ctx.parsed.y} done` } } } },
  }));
}

// Draw all charts; called after the Progress view's HTML is in the DOM.
// opts: { sprintDist, sprintTarget } for the sprint progression chart.
export function drawProgressCharts(sessions, logs, opts = {}) {
  destroyCharts();
  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
  lineChart('ch-squat', 'wrap-squat', valueSeries(sorted, logs, 'squatKg'),
    { color: C.accent, unit: 'kg', empty: 'Log a squat top-set (kg) to start this chart.' });
  lineChart('ch-hip', 'wrap-hip', valueSeries(sorted, logs, 'hipThrustKg'),
    { color: C.silver, unit: 'kg', empty: 'Log a hip-thrust load (kg) to start this chart.' });
  sprintChart(sorted, logs, opts);
  lineChart('ch-readiness', 'wrap-readiness', valueSeries(sorted, logs, 'readiness'),
    { color: C.silver, unit: '/10', empty: 'Log readiness when you train to see the trend.' });
  const bw = (opts.bodyweight || []).slice().sort((a, b) => a.date.localeCompare(b.date)).map(p => ({ date: p.date, v: p.kg }));
  lineChart('ch-bw', 'wrap-bw', bw,
    { color: C.accent, unit: 'kg', empty: 'Log your bodyweight to start this chart.' });
  adherenceChart(sorted, logs);
}
