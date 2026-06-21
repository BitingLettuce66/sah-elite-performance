# Design Direction v2 — "Quiet Luxury, executed" (DRAFT — for Sam's review)

Goal: take the app from *clean* → *covetable*. Premium, calm, athletic. Dark-only. Build on a branch; Sam picks the final accent + display font from options.

## The 5 moves (the thesis)
1. **Distinctive display type** for the wordmark, headings and big metrics. Body stays a system humanist sans.
2. **Restraint with the accent.** Reserve it for the single primary action + the "today/live" state. Everywhere else uses neutral / platinum. (Today the accent is on buttons, pills, toggles, dots — too much.)
3. **Tonal elevation, not borders.** Replace most 1px borders with subtle surface steps + soft shadow.
4. **Moments + breathing room.** Today opens to a calm hero; more negative space; fewer competing elements per screen.
5. **Cohesive cool-neutral palette.** Remove the warm-text/cool-bg clash; refined ice-blue + platinum.

## Tokens (draft — single source of truth)
**Colour (cool-neutral dark ramp):**
`--bg #0A0A0B` · `--surface-1 #131316` · `--surface-2 #1A1A20` (card) · `--surface-3 #20212B` (hover) · `--hairline rgba(255,255,255,.06)` (use sparingly) · `--text #F2F4F7` · `--muted #9A9CA3` · `--faint #6A6C72` · `--accent #8FCBE8` (ice-blue, used sparingly) · `--accent-ink #06223A` · `--platinum #C9CDD6` · `--success #5DAE7E` · `--warn #E0B15A` · `--danger #C0563E`
**Accent options to render:** A = `#8FCBE8` (bright ice), B = `#6FB7E0` (deeper), C = `#A9B4C2` (near-platinum, ultra-restrained).
**Elevation:** card = `0 8px 24px rgba(0,0,0,.35)`; primary glow = `0 6px 22px rgba(143,203,232,.20)`.
**Radii:** sm 12 · md 16 · lg 22 (sheets).
**Type scale:** display 27/600 tight (-0.01em) · h 19/600 · body 14.5/1.55 · label 11 caps .18em · metric 34/700 **tabular**.
**Display font options to render:** A "Space Grotesk", B "Hanken Grotesk", C "Geist". Body: system sans.
**Motion:** 120–260ms ease / cubic-bezier(.2,.8,.2,1); keep existing sheet/fade; respect reduced-motion.
**Spacing:** 4-based; screen padding 20px; more vertical rhythm between sections.

## Component moves
- **Cards:** `--surface-2`, no border, soft shadow, radius-md. Hero/Today card: larger radius + more padding.
- **Sprint/Gym blocks:** tonal, accent/platinum left-hairline + label only, more padding, no full border.
- **Buttons:** primary = accent fill + glow (the ONE accent fill on screen); secondary = ghost + hairline.
- **Pills/toggles:** neutral by default; accent **only** when active or for HIGH/today.
- **Bottom nav:** active = accent, rest faint; slightly larger icons.
- **Today hero:** eyebrow → large display title → meta dot; week strip as subtle dots.
- **Empty/loading:** refined, centered, calm.

## Out of scope (do WITH Sam, not blind overnight)
- The **final** accent + display-font pick → build all options into a styleguide for Sam to choose.
- Logo / app-icon redesign → Canva + Gemini, with Sam.
