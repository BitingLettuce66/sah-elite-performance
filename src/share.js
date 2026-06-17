/* SAH Elite Performance — content engine.
   Draws on-brand shareable cards on a Canvas (Quiet-Luxury theme) at full
   resolution for stories (1080×1920) and feed (1080×1080), then shares via
   the Web Share API (iOS share sheet) or downloads a PNG. */

const SIZES = { story: { w: 1080, h: 1920 }, feed: { w: 1080, h: 1080 } };
const COL = {
  bg: '#0B0B0C', text: '#ECEAE3', muted: '#8A8A90',
  accent: '#7FB2D9', silver: '#C9CBD1', line: '#26262B', green: '#5DAE7E',
};
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',Roboto,sans-serif";

const setFont = (ctx, weight, size) => { ctx.font = `${weight} ${size}px ${FONT}`; };
const line = (ctx, x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };

// Word-wrap `text` into at most `maxLines`, ellipsizing the last; returns new y.
function wrap(ctx, text, x, y, maxW, lineH, maxLines) {
  const words = (text || '').toString().split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const wd of words) {
    const test = cur ? cur + ' ' + wd : wd;
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = wd; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  let out = lines;
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines);
    let last = out[maxLines - 1];
    while (ctx.measureText(last + '…').width > maxW && last.length) last = last.replace(/\s?\S$/, '');
    out[maxLines - 1] = last + '…';
  }
  for (const ln of out) { ctx.fillText(ln, x, y); y += lineH; }
  return y;
}

function brand(ctx, pad) {
  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = '6px';
  setFont(ctx, 800, 30); ctx.fillStyle = COL.accent;
  ctx.fillText('SAH', pad, 120);
  const sahW = ctx.measureText('SAH').width;
  setFont(ctx, 600, 30); ctx.fillStyle = COL.muted;
  ctx.fillText(' ELITE PERFORMANCE', pad + sahW, 120);
  ctx.letterSpacing = '0px';
  ctx.strokeStyle = COL.accent; ctx.lineWidth = 4;
  line(ctx, pad, 150, pad + 90, 150);
}

function eyebrow(ctx, txt, pad, y, color = COL.accent) {
  ctx.letterSpacing = '8px'; setFont(ctx, 700, 30); ctx.fillStyle = color;
  ctx.fillText(txt, pad, y); ctx.letterSpacing = '0px';
}

function footer(ctx, w, h, pad, txt) {
  setFont(ctx, 500, 28); ctx.fillStyle = COL.muted; ctx.textAlign = 'left';
  ctx.fillText(txt || '', pad, h - 88);
}

function drawSession(ctx, w, h, pad, size, d) {
  const maxW = w - 2 * pad;
  let y = 300;
  eyebrow(ctx, d.done ? 'SESSION COMPLETE' : 'TODAY', pad, y); y += 96;
  setFont(ctx, 800, 100); ctx.fillStyle = COL.text;
  y = wrap(ctx, d.focus, pad, y, maxW, 104, 2); y += 16;
  setFont(ctx, 500, 34); ctx.fillStyle = COL.muted;
  ctx.fillText(`${d.phase} · Wk ${d.week} · ${d.day}${d.surface ? ' · ' + d.surface : ''}`, pad, y); y += 56;
  ctx.strokeStyle = COL.line; ctx.lineWidth = 2; line(ctx, pad, y, w - pad, y); y += 64;

  const block = (label, body, color, maxLines) => {
    if (!body || body === '—') return;
    ctx.letterSpacing = '4px'; setFont(ctx, 700, 26); ctx.fillStyle = color;
    ctx.fillText(label, pad, y); ctx.letterSpacing = '0px'; y += 46;
    setFont(ctx, 400, 38); ctx.fillStyle = COL.text;
    y = wrap(ctx, body, pad, y, maxW, 50, maxLines); y += 44;
  };
  block('SPRINT', d.sprint, COL.accent, size === 'feed' ? 2 : 3);
  if (size !== 'feed') block('GYM', d.gym, COL.silver, 4); // square is too tight for the gym block

  if (d.metric) {
    const my = h - 230;
    ctx.letterSpacing = '4px'; setFont(ctx, 700, 26); ctx.fillStyle = COL.muted;
    ctx.fillText(d.metric.label.toUpperCase(), pad, my); ctx.letterSpacing = '0px';
    setFont(ctx, 800, 84); ctx.fillStyle = COL.accent;
    ctx.fillText(`${d.metric.value} ${d.metric.unit}`, pad, my + 84);
  }
}

function drawPR(ctx, w, h, pad, size, d) {
  ctx.textAlign = 'center';
  let y = size === 'feed' ? h * 0.40 : h * 0.36;
  eyebrow(ctx, 'PERSONAL BEST', w / 2, y); // eyebrow uses left baseline; center via textAlign
  ctx.textAlign = 'left';
  if (!d.pr) {
    ctx.textAlign = 'center';
    setFont(ctx, 800, 120); ctx.fillStyle = COL.text; ctx.fillText('—', w / 2, y + 220);
    setFont(ctx, 500, 40); ctx.fillStyle = COL.muted;
    ctx.fillText('Log a number to make a PR card', w / 2, y + 320);
    ctx.textAlign = 'left';
    return;
  }
  const numStr = String(d.pr.value);
  y += size === 'feed' ? 280 : 320;
  setFont(ctx, 800, 320); const nw = ctx.measureText(numStr).width;
  setFont(ctx, 600, 96); const uw = ctx.measureText(' ' + d.pr.unit).width;
  const sx = (w - (nw + uw)) / 2;
  setFont(ctx, 800, 320); ctx.fillStyle = COL.text; ctx.textAlign = 'left';
  ctx.fillText(numStr, sx, y);
  setFont(ctx, 600, 96); ctx.fillStyle = COL.accent;
  ctx.fillText(' ' + d.pr.unit, sx + nw, y);
  ctx.textAlign = 'center';
  setFont(ctx, 600, 56); ctx.fillStyle = COL.silver;
  ctx.fillText(d.pr.label, w / 2, y + 120);
  ctx.textAlign = 'left';
}

function drawRecap(ctx, w, h, pad, size, d) {
  let y = 300;
  eyebrow(ctx, 'WEEKLY RECAP', pad, y); y += 110;
  setFont(ctx, 800, 92); ctx.fillStyle = COL.text;
  ctx.fillText(`Week ${d.week}`, pad, y); y += 60;
  setFont(ctx, 500, 40); ctx.fillStyle = COL.muted;
  ctx.fillText(d.phase, pad, y); y += size === 'feed' ? 110 : 180;

  setFont(ctx, 800, 200); ctx.fillStyle = COL.accent;
  ctx.fillText(`${d.done}`, pad, y);
  const dw = ctx.measureText(`${d.done}`).width;
  setFont(ctx, 600, 80); ctx.fillStyle = COL.muted;
  ctx.fillText(` / ${d.total}`, pad + dw, y);
  setFont(ctx, 500, 44); ctx.fillStyle = COL.text;
  ctx.fillText('sessions completed', pad, y + 64); y += 64 + (size === 'feed' ? 90 : 150);

  setFont(ctx, 800, 64); ctx.fillStyle = COL.green;
  ctx.fillText(`${d.streak}`, pad, y);
  const sw = ctx.measureText(`${d.streak}`).width;
  setFont(ctx, 500, 44); ctx.fillStyle = COL.muted;
  ctx.fillText(` day streak`, pad + sw, y);
}

const round2 = v => Math.round(v * 100) / 100;

// A hand-drawn line chart of a metric's progress over the season.
function drawProgress(ctx, w, h, pad, size, d) {
  let y = 300;
  eyebrow(ctx, 'PROGRESS', pad, y); y += 92;
  setFont(ctx, 800, 84); ctx.fillStyle = COL.text;
  ctx.fillText(d.title || 'Progress', pad, y);
  if (!d.points || d.points.length < 2) {
    setFont(ctx, 500, 40); ctx.fillStyle = COL.muted;
    ctx.fillText('Log a few numbers to chart your progress.', pad, y + 90);
    return;
  }
  const pts = d.points, first = pts[0].v, last = pts[pts.length - 1].v, delta = round2(last - first);
  y += 56;
  setFont(ctx, 600, 44); ctx.fillStyle = COL.muted;
  ctx.fillText(`${first} → ${last} ${d.unit || ''}  (${delta >= 0 ? '+' : ''}${delta})`, pad, y);
  const cx = pad, cw = w - 2 * pad, cyTop = y + 60, cyBot = size === 'feed' ? h - 210 : h - 380, chH = cyBot - cyTop;
  const vals = pts.map(p => p.v); let mn = Math.min(...vals), mx = Math.max(...vals); if (mn === mx) { mn -= 1; mx += 1; }
  const X = i => cx + (i / (pts.length - 1)) * cw, Y = v => cyBot - ((v - mn) / (mx - mn)) * chH;
  ctx.strokeStyle = COL.line; ctx.lineWidth = 1; line(ctx, cx, cyBot, cx + cw, cyBot);
  ctx.beginPath(); ctx.moveTo(X(0), Y(pts[0].v));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(X(i), Y(pts[i].v));
  ctx.lineTo(X(pts.length - 1), cyBot); ctx.lineTo(X(0), cyBot); ctx.closePath();
  ctx.fillStyle = COL.accent + '22'; ctx.fill();
  ctx.beginPath(); ctx.moveTo(X(0), Y(pts[0].v));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(X(i), Y(pts[i].v));
  ctx.strokeStyle = COL.accent; ctx.lineWidth = 5; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.fillStyle = COL.accent;
  [0, pts.length - 1].forEach(i => { ctx.beginPath(); ctx.arc(X(i), Y(pts[i].v), 9, 0, Math.PI * 2); ctx.fill(); });
}

export function drawCard(canvas, type, size, data) {
  const { w, h } = SIZES[size] || SIZES.story;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = COL.line; ctx.lineWidth = 2; ctx.strokeRect(1, 1, w - 2, h - 2);
  brand(ctx, 90);
  const pad = 90;
  if (type === 'pr') drawPR(ctx, w, h, pad, size, data);
  else if (type === 'recap') drawRecap(ctx, w, h, pad, size, data);
  else if (type === 'progress') drawProgress(ctx, w, h, pad, size, data);
  else drawSession(ctx, w, h, pad, size, data);
  footer(ctx, w, h, pad, data.footer);
}

const toBlob = canvas => new Promise(res => canvas.toBlob(res, 'image/png'));

export async function saveCanvas(canvas, filename) {
  const blob = await toBlob(canvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Share via the iOS share sheet when available; otherwise fall back to download.
export async function shareCanvas(canvas, filename) {
  const blob = await toBlob(canvas);
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'SAH Elite Performance' }); }
    catch (e) { /* user dismissed the sheet */ }
  } else {
    await saveCanvas(canvas, filename);
  }
}
