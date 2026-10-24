# Chord trainer: a free curriculum (two axes + a path)

Mockup: prototype `proto-1789461303-updb` (the version after "move Chords inside Path").
Replaces the step ladder of `research/2026-09-19-apps-chord-trainer-curriculum.md`.

## Context

Today the curriculum is one ladder: every step either unlocks chords or widens
how much of the loop you name, and you climb it in order (level 1, 2, 3…). The
user wants the two things split apart and put under their own control:

1. **Which chords** — every chord is *Practise* (can be a blank, has an answer
   button), *Hear only* (can appear in loops, always given) or *Off* (no loop
   with it plays).
2. **How much is blank** — *One* (a single box), *Half* (the loop's second
   half), *All* (every box). Only practised chords are ever blank.

Both can be changed at any time. The curriculum survives as a **path**: a
guide, never a gate. Decisions taken with the user:

- Path rows are a **fixed, hand-written list** per chapter (not ranked from songs).
- **Start fresh**: the old unlock history is dropped; everyone starts at
  chapter 1, row 1 (I IV V practised, Blanks = Half).

## What the learner sees (from the mockup)

Main column unchanged: song card, answer strip (given boxes dimmed), answer
buttons — now **one per practised chord** only. No ghost "next chord" pad.

Side panel, top to bottom:

1. **Today** (and the existing all-time line).
2. **Your chords** — a segmented progress bar (one segment per route cell of
   the current chapter: done / next / todo, hover names it), then one row per
   chord that is not Off: chip, accuracy meter, %, median time, mastered dot.
   Hear-only chords get a dimmed row reading "hear only". No "Level N", no Undo.
3. **Path** card, collapsed by default. Closed: "Path · On track / Off the route
   / Free practice", plus a **Resume: ‹row› · ‹blanks›** button when the
   current settings are not the suggested cell. Open, in order:
   - **Chords**: chips for chapter 1's chords plus every chord not Off; click
     cycles Practise → Hear → Off (hear shows a small ear badge, off is dashed).
     A **+** menu lists the other chapters (families) with a
     Practise / Hear / Off switch for the whole family.
   - **Blanks**: One · Half · All segmented control.
   - A short note: where you are, progress on the suggested cell, **Go** /
     **Back to the path**.
   - The chapter accordion: each chapter opens to its map (rows × One/Half/All),
     cells filled by mastery, ring = you are here, pulse = next, dashed = off
     the route. Clicking a cell applies its settings.

## Model

### Path data (core, plain data — a closed list)

`curriculum/core/path.ts`:

```ts
type PathRow = { id: string; name: string; tokens: ChordToken[]; modes?: HookpadMode[] };
type Chapter = { id: StageId; name: string; blurb: string; rows: PathRow[] };
export const CHAPTERS: Chapter[];        // hand-written, mockup contents
export const BLANKS = ["one", "half", "all"] as const;
routeOf(chapter): [rowId, Blanks][]      // row 0: one, half, all; later rows: one, all
cellSettings(chapter, rowId, blanks): Selection   // what clicking a cell sets
cellOf(selection): Cell | null           // inverse, to draw "you are here"
nextCell(standings): Cell | null         // first route cell not mastered
```

`cellSettings`: rows up to and including this one are Practise, except for a
new row on `one`, where the earlier rows are Hear only (the new chord is heard
alone against known ones). Earlier chapters' rows stay Practise. A row's
`modes` (minor keys, the four modes) turn those key modes on.

Chapter ids reuse `StageId`, and a check in `path.test.ts` asserts every row
token belongs (via `stageOf`) to its chapter's stage — so the hand list cannot
drift from how the app classifies chords. `stages.ts` stays (membership +
seeds); `ladder.ts`, `step.ts`, `first-level.ts`, the notion machinery and
`chooseNextStep` are deleted.

### Selection (server, a table + live resource)

Replaces `chord_unlocks`. New table in `curriculum/server/internal/tables.ts`:

```
chord_selection
  token      text primary key          -- ChordToken
  state      text not null             -- "practice" | "hear"   (absent = off)
chord_settings (single row, id = 1)
  blanks     text not null default 'half'
  modes      jsonb not null            -- HookpadMode[] turned on
```

Absent row = Off, so the table only holds what is on (bounded by the chord
vocabulary; a small schema-bounded value, fine under the live-state rule).
Both parsed with `sql-column.parsedText/parsedJson`. The migration seeds the
start state (I, IV, V practice; half; `["major"]`) and drops `chord_unlocks`.

Resource `chord.curriculum` is redefined as the **selection**:
`{ chords: {token, state}[], blanks, modes }` (read by trainer + panel).

Endpoints (`curriculum/core/endpoints.ts`), all one transaction, all return nothing
(the resource pushes the change):

- `POST /api/chord/curriculum/chord` `{ token, state: practice|hear|off }`
- `POST /api/chord/curriculum/family` `{ stage, state }` — every chord of that
  chapter's rows (+ its modes on/off)
- `POST /api/chord/curriculum/blanks` `{ blanks }`
- `POST /api/chord/curriculum/apply` `{ chapter, row, blanks }` — the server
  computes `cellSettings` and replaces the whole selection (a client never
  sends a whole selection it computed)

Delete `next`, `unlock`, `undo`, `next.ts`, `state.ts` (+ tests).

### Asking (core)

`askedPositions(boxes, { blanks, practised: Set<ChordToken>, target })` in
`curriculum/core/ask.ts`, rewritten:

- practised boxes = boxes whose chord is Practise;
- `one` → the target's last box; `half` → practised boxes starting at or after
  the window midpoint; `all` → every practised box;
- never empty: falls back to the last practised box (the loop query
  guarantees the target is present, so there always is one).

`targetIsIsolated`, `FRESH_ANSWERS`, levels: deleted.

### Loops (no song-index change)

`findLoopsEndpoint` already takes `{ unlocked, target, modes }` and guarantees
every chord ∈ `unlocked` and the target present. Trainer passes
`unlocked = practise ∪ hear`, `target = weakestChord(practised, …)`
(`trainer/core/target.ts`, restricted to practised), `modes` from the
selection. Any selection change invalidates the queue (the existing
`liveBatch` key, now keyed on the selection).

Empty case: no practised chord, or `find` returns no candidates → the sheet
shows "No song fits these chords…" instead of a round.

### Mastery per blanks (progress)

Path cells need "how well do you know vi when half the loop is blank":

- `chord_rounds` gains `blanks text null` (null = rounds before this change);
  `recordRound` takes it from the trainer.
- `ChordStanding` gains `byBlanks: Record<Blanks, {answers, accuracy, mastered}>`,
  each over that level's last `MASTERY_WINDOW` answers (same `chordMastery`).
  One windowed query grouped by (token, blanks) in `progress/server/internal/progress.ts`.
- A cell is mastered when every token of its row is mastered at that blanks
  level; its fill is the mean of `accuracy × min(1, answers/20)`.

`givenCount` stays.

## Files

- `plugins/apps/plugins/chord/plugins/curriculum/`
  - core: new `path.ts` (+ test), rewrite `ask.ts` (+ test), `resource.ts`,
    `endpoints.ts`, `index.ts`; delete `ladder.ts`, `step.ts`, `first-level.ts`
    and their tests.
  - server: `tables.ts`, `handlers.ts`, `resource.ts`; delete `next.ts`, `state.ts`.
  - web: `use-curriculum.ts` → `useCurriculum`, `useSetChordState`,
    `useSetFamily`, `useSetBlanks`, `useApplyCell`; new `<PathCard>`
    (collapsed card with `<ChordChips>`, `<BlanksControl>`, coach note,
    `<ChapterMap>`); delete `NextStepPad`, `NextStepRow`, `readiness.ts`,
    `step-wording.ts`, `next-step.css`.
  - CLAUDE.md rewritten.
- `plugins/apps/plugins/chord/plugins/trainer/web/components/`
  - `trainer-screen.tsx` — selection instead of unlocked/level; new
    `askedPositions` call; pass `blanks` to the round save; empty state.
  - `chord-buttons.tsx` — practised chords only, no pad.
  - `progress-panel.tsx` — Today, Your chords (bar + rows incl. hear-only),
    `<PathCard>`.
  - `trainer/core/target.ts` — weakest among practised.
- `plugins/apps/plugins/chord/plugins/progress/` — `blanks` column, `byBlanks`
  standings, record endpoint body.
- Migration via `./equin build` (DDL) + a data migration seeding the
  start selection.
- e2e: rewrite `curriculum/e2e/curriculum-verify.ts`; delete `ladder-preview.ts`;
  adjust `trainer/e2e/trainer-verify.ts` and `piano/e2e/piano-shot.ts` if they
  drive the level control.

Reuse: `chordToneStyle` / `<ChordNumeral>` (vocabulary) for chips and map
row labels; `chordMastery` (progress/core/mastery.ts); `stageOf` for the
family menu and the drift check; `section-card` / `collapsible` primitives for
the Path card and chapter accordion; data-view is not needed (fixed small
chrome lists — annotate the `no-adhoc-row-list` disables).

## Verification

1. `./equin test plugins/apps/plugins/chord` — new `path.test.ts`
   (route shape, `cellSettings`/`cellOf` round-trip, every row token in its
   chapter's stage), `ask.test.ts` (one/half/all, never empty, only practised),
   progress `byBlanks` test.
2. `./equin build`, then open the trainer:
   - fresh start shows I IV V, Half, 2 boxes to name with the rest given;
   - clicking vi's chip (Off → Practise) adds a vi button and loops with vi;
     setting it to Hear removes the button and vi boxes come given;
   - One / All change the number of blanks on the current loop;
   - clicking a map cell sets both; the Path header reads On track / Off the route;
   - turning everything off shows the empty state.
3. `curriculum-verify.ts` e2e drives the above, and restores the selection
   it found when it ends.
4. Screenshot the side panel against the mockup (`screenshot.ts --path /chord`).
