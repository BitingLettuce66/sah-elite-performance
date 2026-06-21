/* SAH Elite Performance — pure presentation helpers + display constants.
   No DOM, no app state — just formatting + small constants used across the UI,
   kept here so the renderer in main.js stays focused on view logic. */

// Session-type pills (label + CSS class).
export const TYPE = {
  HIGH:{label:'HIGH',cls:'t-high'}, MOD:{label:'MOD',cls:'t-mod'},
  DELOAD:{label:'DELOAD',cls:'t-deload'},
  TAPER:{label:'TAPER',cls:'t-taper'}, LOW:{label:'LOW',cls:'t-low'},
  RECOVERY:{label:'REST',cls:'t-rest'}, RACE:{label:'RACE',cls:'t-race'}
};
// Niggle levels for the readiness log (None → Stop).
export const NIGGLE = ['None','Monitor','Modify','Stop'];

// Today's date as a local YYYY-MM-DD (DST-safe).
export const todayISO = () => { const d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,10); };
// Round to dp decimals, killing float artefacts (e.g. 3.7399999 → 3.74). null stays null.
export const round = (v, dp) => v==null ? null : Math.round(v * 10**dp) / 10**dp;
// Escape the three HTML-significant chars for safe interpolation into markup.
export const esc = s => (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
// Slugify a label into an element-id fragment (e.g. "30m fly" → "30m-fly").
export const slug = s => s.replace(/[^a-z0-9]+/gi, '-');
// A short, human date: "Fri, 19 Jun".
export const fmtDate = iso => new Date(iso+'T00:00').toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'});
// A month heading: "June 2026".
export const monthLabel = iso => new Date(iso+'T00:00').toLocaleDateString('en-AU',{month:'long',year:'numeric'});
// The pill markup for a session type (unknown types fall back to LOW).
export const pill = t => { const m=TYPE[t]||TYPE.LOW; return `<span class="pill ${m.cls}">${m.label}</span>`; };
