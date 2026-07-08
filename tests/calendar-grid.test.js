// Regression guard for the History calendar grid.
//
// The bug: months that don't start on Monday rendered leading empty filler
// cells. Empty grid items inherited .cal-cell's aspect-ratio:1 and inflated the
// first row; with minmax(auto,1fr) columns they also blew the 7 columns out past
// the container (oversized cells / horizontal overflow). Clean months looked fine.
//
// The fix: no filler cells — day 1 is placed with grid-column-start — plus a
// load-bearing min-width:0 on .cal-cell so columns resolve to container/7.
//
// This test must FAIL if either half regresses: filler cells reappear, day 1 is
// mis-placed, or the CSS squareness/overflow guard is removed.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { calendarCells } from '../src/calendar.js';

const DOW = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const startWeekday = (y, m) => (new Date(y, m-1, 1).getDay()+6)%7;   // 0=Mon … 6=Sun
const daysInMonth  = (y, m) => new Date(y, m, 0).getDate();

// Render a month with a couple of sessions so both cell branches (plain day +
// session button) are exercised, including day 1 (the placed cell).
function render(y, m){
  const mm = String(m).padStart(2,'0');
  const sessions = [
    { id:'s1', date:`${y}-${mm}-01`, focus:'First' },
    { id:'s2', date:`${y}-${mm}-15`, focus:'Mid' },
  ];
  return calendarCells({ year:y, month:m, today:`${y}-${mm}-15`, sessions, logs:{} });
}

// All cal-cell opening tags, and the day numbers actually rendered.
function parse(cells){
  const cellTags = cells.match(/<(?:span|button)[^>]*class="cal-cell[^>]*>/g) || [];
  const dayNums  = cells.match(/<span class="cal-num">\d+<\/span>/g) || [];
  const offsets  = cells.match(/grid-column-start:\d+/g) || [];
  return { cellTags, dayNums, offsets };
}

// 2026–2028 covers every possible start weekday and every month length,
// including the leap-February (2028-02 = 29 days).
const MONTHS = [];
for(let y=2026; y<=2028; y++) for(let m=1; m<=12; m++) MONTHS.push([y, m]);

describe('calendar grid coverage', () => {
  it('the tested months span all 7 start weekdays and all lengths (28/29/30/31)', () => {
    const sw   = new Set(MONTHS.map(([y,m]) => startWeekday(y,m)));
    const lens = new Set(MONTHS.map(([y,m]) => daysInMonth(y,m)));
    expect([...sw].sort((a,b)=>a-b)).toEqual([0,1,2,3,4,5,6]);
    expect([...lens].sort((a,b)=>a-b)).toEqual([28,29,30,31]);
    expect(daysInMonth(2028,2)).toBe(29);   // leap February, explicitly
  });
});

describe('calendar grid — no filler cells, day 1 placed via grid-column-start', () => {
  for(const [y, m] of MONTHS){
    const sw = startWeekday(y, m), dim = daysInMonth(y, m);
    it(`${y}-${String(m).padStart(2,'0')} starts ${DOW[sw]}, ${dim} days — square & fillerless`, () => {
      const { cells } = render(y, m);
      const { cellTags, dayNums, offsets } = parse(cells);

      // Exactly one cell per day — no extra leading/trailing cells.
      expect(cellTags.length).toBe(dim);
      // Every cell carries a day number → there are NO empty filler cells (the bug).
      expect(dayNums.length).toBe(dim);
      expect(cells).not.toContain('cal-cell empty');

      // Day 1 placement. Mon-start flows naturally (no offset); otherwise day 1
      // alone carries grid-column-start = its 1-based weekday column. Because the
      // offset is grid placement (not a filler element), the first row has the
      // same square cells as every other row → uniform row height.
      const firstTag = cellTags[0];
      if(sw === 0){
        expect(offsets.length).toBe(0);
        expect(firstTag).not.toContain('grid-column-start');
      } else {
        expect(offsets).toEqual([`grid-column-start:${sw+1}`]);   // exactly one, correct column
        expect(firstTag).toContain(`grid-column-start:${sw+1}`);   // and it's on day 1
      }
    });
  }
});

describe('calendar grid — CSS squareness & overflow guard', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

  it('grid is exactly 7 columns', () => {
    expect(css).toMatch(/\.cal-grid\{[^}]*grid-template-columns:repeat\(7,1fr\)/);
  });
  it('.cal-cell keeps aspect-ratio:1 AND the load-bearing min-width:0', () => {
    expect(css).toMatch(/\.cal-cell\{[^}]*aspect-ratio:1/);
    expect(css).toMatch(/\.cal-cell\{[^}]*min-width:0/);   // remove this and columns overflow again
  });
  it('the inflating .cal-cell.empty filler rule stays gone', () => {
    expect(css).not.toMatch(/\.cal-cell\.empty/);
  });
});
