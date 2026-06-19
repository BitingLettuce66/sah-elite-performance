# SAH Elite Performance — Design System

A **dark-only, mobile-first** design language ("Quiet Luxury"): jet black, a calm cool-blue accent, silver, generous spacing, sleek cards. UX reference: Strava / Runna. Build screens that feel premium, quiet, and uncluttered.

> **This is a tokens + CSS-class system, not a component bundle.** There are no importable React components. You style with **CSS custom properties (`var(--*)`)** and a set of **semantic classes** defined in `styles.css`. Reuse those classes and the markup patterns below; only write new CSS when a pattern doesn't exist, and when you do, use the tokens — never hardcode hex values. Read `styles.css` before styling: it is the source of truth.

## Foundations

**Dark only.** `:root { color-scheme: dark }` is set deliberately — never add a light theme.

**Mobile-first.** The app frame is centered and capped: `#app { max-width: 520px; margin: 0 auto }`. Design at phone width; the frame is a sticky top bar (`#topbar`) + scrolling `#view` + fixed bottom nav (`#tabbar`).

**Palette** (use the token, not the hex):

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0B0B0C` | Page background (jet black) |
| `--surface` | `#141417` | Card / panel surface |
| `--surface2` | `#1C1C20` | Inset surface — callouts, inputs, chips |
| `--line` | `#26262B` | Borders, dividers |
| `--text` | `#ECEAE3` | Primary text (warm off-white) |
| `--muted` | `#8A8A90` | Secondary text, labels, icons |
| `--accent` | `#7FB2D9` | **Primary accent — cool light blue.** Active state, primary buttons, sprint, links |
| `--accent-dim` | `#46647A` | Dimmed accent — upcoming/secondary |
| `--silver` | `#C9CBD1` | Silver — gym highlight, race |
| `--green` | `#5DAE7E` | Success / done |
| `--red` | `#C0563E` | Destructive |

The accent is **cool light blue (`#7FB2D9`)** — not gold. Don't substitute another accent.

**Typography.** System stack: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif`. Weights 500 / 600 / 700. Scale: hero number 34px/700 (`.stat b`), card title 25px/700, sheet title 19px, section 17px, body 14–15px, meta 12–13px. **Eyebrows / labels** are the signature: 11–12px, UPPERCASE, wide letter-spacing (`.06em`–`.18em`), `--muted`.

**Radii:** `--radius` 16px (cards/panels), `--radius-sm` 11px (buttons, insets); pills 20px; inputs/small controls 10px; bottom sheet top corners 22px.

**Spacing rhythm:** screen padding 16–18px; card padding 16–18px; gaps 6–14px. Keep it airy.

## Class vocabulary (real names from `styles.css`)

**Shell:** `#app`, `#topbar` (+ `.brand`, `.avatar`, `.phase`), `#view`, `#tabbar` (+ `button.active`, `.ic` for a 23px inline SVG icon).

**Headings:** `.eyebrow` (uppercase section label).

**Cards:** `.card`, `.card-top`, `.card-title`, `.meta`, `.card-actions`. Generic panel: `.backup`, `.checkpoint`, `.chart-card`, `.stat`.

**Type pills (badges):** `.pill` + a modifier — `.t-high` (filled accent), `.t-deload` / `.t-taper` (outline accent), `.t-low` (silver outline), `.t-rest` (muted outline), `.t-race` (filled silver). Done marker: `.done`.

**Callouts (accented info blocks):** `.callout` + `.sprint` (blue edge) / `.gym` (silver edge) / `.rest` (muted edge); inner label `.co-h`.

**Buttons:** `.btn-save` (filled accent, primary), `.btn-cancel` (outline, secondary), `.btn-done` (filled accent CTA), `.btn-log` (full-width outline accent), `.btn-delete` (`.armed` turns red), `.link-btn` (text accent). Group in `.sheet-actions` (sheets) or `.card-actions` (cards).

**Forms / sheets:** `.modal` (`.hidden` to close) → `.sheet` (bottom sheet, `h3` title); `.field` (`label` + `input`/`select`/`textarea`); `.seg` segmented control (`button.sel` = selected); `.nums` (2-col number inputs).

**Lists & history:** `.list`, `.hist-head`, `.hist-toggle` (`button.sel`), `.month-head`, `.row` (`.is-today`), `.row-main`, `.row-date`, `.row-focus`, `.row-dot` (`.done`/`.missed`/`.future`).

**Calendar:** `.cal-nav`, `.cal-month`, `.cal-arrow`, `.cal-grid`, `.cal-dow`, `.cal-cell` (`.has`/`.empty`/`.today`), `.cal-num`, `.cal-dot` (`.done`/`.missed`/`.future`), `.cal-legend`.

**Today:** `.week-strip`, `.wk-cell` (`.done`/`.missed`/`.future`/`.today`) with `.wk-day` + `.wk-dot`; `.nextup` (+ `.nextup-label`/`.nextup-body`/`.nextup-focus`/`.nextup-date`).

**Stats / progress:** `.stats` → `.stat` (`b` = big number, `span` = label); `.empty` (empty state); `.chart-card` + `.chart-wrap`/`.chart-empty`; sprint PBs `.pb-grid`/`.pb`/`.pb-dist`/`.pb-time`/`.pb-target`; `.dist-chips` + `.chip` (`.sel`).

## Pattern examples (copy these)

**Section + card:**
```html
<p class="eyebrow">Today</p>
<article class="card">
  <div class="card-top">
    <span class="pill t-high">HIGH</span>
    <span>P1 Accel · Wk 1 · Fri</span>
    <span class="done">✓ Logged</span>
  </div>
  <h2 class="card-title">Establish</h2>
  <div class="meta">Fri, 19 Jun · Track</div>
  <div class="callout sprint"><span class="co-h">Sprint</span>6×20m @≤90%, walk-back recovery.</div>
  <div class="callout gym"><span class="co-h">Gym</span>Back squat 3×5 · hip thrust · Nordics.</div>
  <div class="card-actions">
    <button class="btn-done">✓ Mark done</button>
    <button class="btn-log">Details</button>
  </div>
</article>
```

**Stat row:**
```html
<div class="stats">
  <div class="stat"><b>12</b><span>sessions logged</span></div>
  <div class="stat"><b>4</b><span>day streak</span></div>
</div>
```

**Bottom sheet (modal):**
```html
<div class="modal"><div class="sheet" role="dialog" aria-modal="true">
  <h3>Log session</h3>
  <div class="field"><label>RPE (1–10)</label>
    <div class="seg"><button>6</button><button class="sel">7</button><button>8</button></div>
  </div>
  <div class="sheet-actions">
    <button class="btn-cancel">Cancel</button><button class="btn-save">Save</button>
  </div>
</div></div>
```

**Bottom nav (icons are 23px inline SVG, stroke `currentColor`):**
```html
<nav id="tabbar" aria-label="Primary">
  <button class="active"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="4"/></svg>Today</button>
  <button>History</button><button>Progress</button><button>Share</button>
</nav>
```

## Do / don't
- **Do** style with `var(--*)` tokens and the classes above; keep it dark, calm, airy; design at ≤520px.
- **Do** use eyebrows (uppercase, spaced) for section labels and big bold numbers for metrics.
- **Don't** use a utility-class system (no Tailwind-style `bg-*`/`p-*`) — this DS has none; write semantic rules with tokens instead.
- **Don't** add a light theme, hardcode hex values, or swap the blue accent for gold.
