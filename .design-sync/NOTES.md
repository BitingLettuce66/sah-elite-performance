# Design-sync notes — SAH Elite Performance

## Why this is a hand-built "tokens + guidelines" sync (not the automatic converter)
The standard `/design-sync` converter bundles an existing **component library** (React/Storybook, or a package that compiles to a `dist/` of components) and ships those real compiled parts into Claude Design. SAH Elite has **no component library**: it's a vanilla-JS PWA whose UI is HTML strings rendered in `src/main.js`, and whose "design system" is the **CSS tokens + semantic classes** in `src/styles.css`. There's nothing to bundle without reimplementing the UI as components, which the converter explicitly forbids.

So this is a lightweight, hand-authored upload: the real stylesheet + tokens + a conventions guide that teaches Claude Design the idiom (palette, type, class vocabulary, patterns). Claude Design then produces **on-brand** SAH screens that reuse the real classes — but it does **not** get drop-in, part-for-part components.

## Source of truth (committed, in `.design-sync/`)
- `conventions.md` — the canonical design guide → uploaded as `README.md`. Edit this when the design language changes.
- `tokens.json` — machine-readable tokens (mirror of `src/styles.css :root`).
- `preview/overview.html` — a visual reference page → uploaded as `_preview/overview.html`.
- `config.json` — the target Claude Design project id + this approach.

`src/styles.css` is the stylesheet source; it is **copied** into the upload, not duplicated in git.

## How to rebuild the upload payload (`ds-bundle/`, gitignored) and re-sync
```sh
rm -rf ds-bundle && mkdir -p ds-bundle/tokens ds-bundle/_preview
cp src/styles.css            ds-bundle/styles.css
cp .design-sync/conventions.md ds-bundle/README.md
cp .design-sync/tokens.json    ds-bundle/tokens/tokens.json
cp .design-sync/preview/overview.html ds-bundle/_preview/overview.html
```
Then upload via the `DesignSync` tool to the project in `config.json` (`write_files` from `ds-bundle/`). Keep `styles.css` self-contained (no `@import`s) so rendered designs get the whole stylesheet.

## When to revisit a real component sync
If/when the app moves to a component-based stack (React/web components — e.g. the future commercial rebuild in App-Spec §10's growth path), build a proper component library from these same tokens and run the full `/design-sync` converter. Until then this lightweight sync is the right fit.

## Validation rule (before each upload)
Every class/token named in `conventions.md` must exist in `src/styles.css` (grep them). A guide that names things which don't exist is worse than none — the design agent will trust it and emit unstyled markup.
