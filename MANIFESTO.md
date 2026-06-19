# SAH Elite Performance — Manifesto

The product north star. Any tool building this (Claude Code, Cowork, or otherwise) should read this **first** and let it steer every decision.

## What we're building
**The AI strength-and-sport coach for everyone Runna leaves out** — a frictionless training hub for general athletes and the coaches who run them.

## What we're against (the gap we attack)
- Race-only, running-only, **template-rigid** apps.
- Expensive 1:1 coaching as the *only* route to elite, personalised programming.
- The clunky spreadsheets coaches use to wrangle many athletes.

## Who we serve
1. **Coaches with many athletes** — one home to build, assign, and track 20+ programs + progress.
2. **Self-coached, capable athletes** — elite structure without staff behind them.
3. **Anyone wanting a balanced gym + sport plan**, delivered friction-free.

## Product principles (build to these)
1. **AI-native at the core.** The headline feature is an AI coach: chat your goals, sport, injuries, equipment and schedule → get a personalised, periodised plan. Plans are *data* the AI generates and edits.
2. **Frictionless.** Strava/Runna-grade UX. Opens to today's session; logging takes seconds; nothing buried.
3. **General, not race-bound.** Strength + sport + gym, any athlete, any goal.
4. **Injury-aware, safely.** Auto-regulation and red-flag stops are first-class (readiness + niggle gates). The AI gives **training guidance, not medical advice** — disclaimers and "see a professional" gates; never diagnose or treat.
5. **Coach and athlete in one system.** Single athlete now; the multi-athlete coach layer is a data addition, not a rebuild.
6. **Private by default.** Health data handled with care; secrets never shipped.
7. **Calm and premium.** Quiet-Luxury: jet black + cool light-blue accent + silver, minimalist.

## The moat
AI-generated, injury-aware, **bespoke plans from a conversation** — for general athletes *and* their coaches. Not templates. Not race-only.

## Build doctrine (for Claude Code & co.)
- Honour the architecture in **App-Spec.md §10** (program is data, stable IDs, planned-vs-performed separate, prescription snapshots, forward-only edits, `athleteId`/`planId` reserved, storage behind `db.js`). That architecture is *what makes the AI coach and the coaching hub possible.*
- Ship in tested steps; explain changes in plain English.
- Don't try to out-feature incumbents everywhere — **protect the wedge**: AI + general + injury-aware + coach layer.
