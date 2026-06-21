// History month-calendar cell rendering — kept pure (no module state / no DOM) so
// it can be unit-tested directly. See tests/calendar-grid.test.js.
//
// CRITICAL invariant: day 1 is positioned with `grid-column-start`, NEVER with
// leading empty filler cells. Empty grid items inherit the cell's aspect-ratio:1
// and inflate the first row's height; combined with minmax(auto,1fr) columns they
// also overflow the grid. Day cells must stay square regardless of which weekday
// the month starts on. (The CSS half of this guard — aspect-ratio:1 + min-width:0
// on .cal-cell — lives in styles.css.)
import { statusOf } from './logic.js';
import { fmtDate, esc } from './format.js';

// Build the day-cells markup for a calendar month.
//   year, month : 1-based month (e.g. {year:2027, month:1} = Jan 2027)
//   today       : ISO 'YYYY-MM-DD' used to mark the current day
//   sessions    : array of session objects with a `date` (ISO), `id`, `focus`
//   logs        : map of sessionId -> log object (for done/missed status)
// Returns { cells, startWeekday, daysInMonth } where startWeekday is 0=Mon..6=Sun.
export function calendarCells({ year, month, today, sessions = [], logs = {} }){
  const byDate = {}; for(const s of sessions) byDate[s.date] = s;
  const startWeekday = (new Date(year, month-1, 1).getDay()+6)%7;   // 0=Mon … 6=Sun
  const daysInMonth = new Date(year, month, 0).getDate();
  let cells = '';
  for(let d=1; d<=daysInMonth; d++){
    const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const se = byDate[iso];
    const isToday = iso===today ? ' today' : '';
    // Place the 1st on its weekday column via grid, not via empty filler cells:
    // empty grid items inherit aspect-ratio:1 and inflate the first row's height.
    const pos = d===1 && startWeekday>0 ? ` style="grid-column-start:${startWeekday+1}"` : '';
    if(!se){ cells += `<span class="cal-cell${isToday}"${pos}><span class="cal-num">${d}</span></span>`; continue; }
    const st = statusOf(se, logs[se.id]||{}, today);   // done | missed | future
    const stWord = st==='done' ? 'done' : st==='missed' ? 'missed' : 'upcoming';   // status in words, not colour alone
    cells += `<button class="cal-cell has ${st}${isToday}" data-id="${se.id}"${pos} aria-label="${fmtDate(iso)} — ${esc(se.focus)} — ${stWord}">
      <span class="cal-num">${d}</span><span class="cal-dot ${st}" aria-hidden="true"></span></button>`;
  }
  return { cells, startWeekday, daysInMonth };
}
