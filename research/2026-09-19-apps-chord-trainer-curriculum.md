# Chord trainer — the curriculum: what unlocks, in what order, and how much you name

Track page: `block-49ba706c-affe-417b-a9a1-b6873e8c7ea8` ("Chord trainer app").
Follows the app itself ([2026-09-18](2026-09-18-apps-chord-trainer-app.md)) and
the song index ([v4](2026-09-17-apps-chord-trainer-song-index-v4.md)). Mockup:
prototype `proto-1789461303-updb`.

## Context

The trainer plays loops, checks answers and tracks mastery, but the chords it
asks for are a fixed placeholder: I, IV and V, root-position, major keys only
(`STARTING_CHORDS` / `STARTING_MODES` in `vocabulary/core`). Nothing moves: no
order in which chords and theory arrive, nothing stored about what this learner
has unlocked, no way to take the next step. The mockup's locked "next chord"
teaser with its **Add it** button is missing too.

There is a second gap, which the placeholder hides: **every round asks for
every chord of the loop at once**. Naming four chords in a row is already hard
with only I, IV and V — the user's own experience. A curriculum that only adds
chords makes the first hour harder, not easier.

Outcome of this step: a ladder the learner climbs one notion at a time. Early
levels fill most of the loop in for you and ask for one chord, then the cadence,
then the whole loop. After that each level adds one chord — the one that opens
the most real songs, from the family being worked through — and the first rounds
with a new chord ask only for *that* chord, the rest of the loop given. The next
step is always visible, locked, with **Add it**; the learner decides when.

## Decisions (user, 2026-09-19)

- **Order: families, ranked by real usage.** A fixed list of chord families
  (stages) says which notion comes next; *within* and *between* families the
  index decides, by how many loops a step opens. No hand-written chord order.
- **The learner decides.** **Add it** is always available; it becomes the
  prominent button once every unlocked chord is mastered, and reads "Add
  anyway" before that.
- **Keys: digit, then pick.** The digit is the chord root's degree (♭VII → 7).
  One unlocked chord on that degree answers at once; several show numbered and a
  second key picks.
- **Exact chords.** A V7 is not a V, a V⁶ is not a V — loops holding a chord you
  have not unlocked stay out, as today.
- **One notion at a time.** A level introduces one thing, and the round is
  scaffolded so that thing is what you actually practise.

## The model

Two axes, one ladder.

- **What you may hear** — the unlocked chord tokens and key modes. They decide
  which loops `find` returns.
- **How much you name** — the *ask rule*: which boxes of the loop are blank.
  The others are given, showing their chord.

A **step** is one move on either axis. A **level** is how many steps you have
taken (level 1 is the start). The ladder:

| Level | Step | What the round asks |
|---|---|---|
| 1 | I, IV, V, major keys | only the boxes of the chord you are practising |
| 2 | ask rule → `half` | every box in the loop's second half (the cadence) |
| 3 | ask rule → `all` | every box |
| 4… | one chord (or a family's seed) each | every box — except while the new chord is fresh |

**Fresh-chord isolation.** A chord unlocked less than `FRESH_ANSWERS = 10`
answers ago is the trainer's target (`weakestChord` already picks the chord with
the fewest answers), and while it is fresh the round asks **only its boxes**
whatever the ask rule. So every new notion arrives isolated, and widens out on
its own.

One rule, in `curriculum/core`, pure:

```ts
askedPositions(boxes, { target, askRule, targetAnswers }): number[]
// "target" or targetAnswers < FRESH_ANSWERS → boxes whose token === target
// "half" → boxes starting at or after the window's midpoint
// "all"  → every box
// never empty: a rule that selects nothing falls back to the last box
```

`find` already guarantees the target is in the window, so the target rule always
has a box.

## Which step comes next

A **stage** is a family of chords, declared once in `curriculum/core`:

```ts
type Stage = {
  id: StageId;
  title: string;                      // "Minor keys"
  modes: readonly HookpadMode[];      // modes this stage opens
  seed: readonly ChordToken[];        // unlocked together, to open the stage
  holds(parts: ChordTokenParts): boolean;  // which chords belong to its pool
};
```

| Stage | Opens | Seed | Pool |
|---|---|---|---|
| `major-triads` | major | I, IV, V | root-position triads on major-scale degrees, diatonic quality (vi, ii, iii, vii°) |
| `minor-keys` | minor | i, ♭VII, ♭VI | the other minor-scale triads (♭III, iv, v) — also the borrowed chords of a major key |
| `sevenths` | — | — | root-position four-tone stacks (V7, ii7, vi7, Imaj7, IVmaj7 …) |
| `inversions` | — | — | any token with an inversion **whose root-position twin is already unlocked** |
| `secondary` | — | — | major triads and dominant 7ths on roots whose diatonic quality is not major (V/V, V/vi, V/ii, I7) |
| `colour` | — | — | anything else: sus4, sus2, add9, 6ths |
| `mixolydian`, `dorian`, `lydian`, `phrygian` | that mode | — | — (the chords are already known; the step opens the mode) |

Every stage but the modal ones classifies by predicate, so a chord the index has
and nobody listed still lands in exactly one pool (first match wins). A chord in
no pool is never offered.

**Choosing.** Given the unlocked set, the index answers two questions:

- *pool chord* — how many windows unlocking exactly this one chord would add
  (the existing `next-chords` scan);
- *stage entry* — how many windows the stage's seed and modes would add
  (a `<@` count over the loop windows, GIN-indexed).

Then, in order:

1. The ask-rule steps first: while the rule is not yet `all`, the next step is
   the next rung.
2. **Stay in the current stage** — the stage the last chord step came from —
   while its best pool chord is worth at least `MIN_STEP_WINDOWS` **and** at
   least a fifth of the best step available anywhere (`STAGE_HOLD_SHARE`). One
   notion is finished before the next starts, but a family's rare leftovers do
   not hold up a much bigger one.
3. Otherwise take the highest-value candidate across all stages: each open
   stage's best pool chord, each unopened stage's seed.

The fifth was added after the first ladder preview on the real index: without
it, "finish the family" put **vii°** (8 windows in the sample) at level 7,
ahead of the whole of minor keys (593). A rare straggler now waits, and comes
back once the families ahead of it have run down — which is what "ranked by
usage" has to mean.

`MIN_STEP_WINDOWS` is a **share of the index**, not a fixed count: 1 in 10,000
of the shape's windows, at least 5. Otherwise a worktree's 5 % sample would
stall where main's full index flows.

Measured, once built, by `e2e/ladder-preview.ts` against this worktree's 5 %
sample (9,612 windows; ×20 for the full index), the ladder runs:

| Level | Step | Opens | Playable after |
|---|---|---|---|
| 1 | I, IV, V, major keys | — | 492 |
| 2–3 | name the cadence, then the whole loop | — | 492 |
| 4–6 | vi (501), ii (184), iii (274) | | 1,451 |
| 7 | i, ♭VII, ♭VI + minor keys | 571 | 2,022 |
| 8–10 | ♭III (387), iv (313), v (251) | | 2,973 |
| 11… | V⁶ (196), I⁶, i⁶₄, IV⁶₄, ♭VII⁶ … | | 3,517 by level 20 |

Minor keys are 44 % of the index's windows, so they arrive long before sevenths
or inversions. That ordering comes from the songs, not from anyone's taste,
which is the point of ranking by usage. The whole walk costs ~38 ms a level.

## What the learner stores

One table, `chord_unlocks`, in a new `curriculum` sub-plugin. It is the
learner's own history, like `chord_rounds`: **kept** in worktree forks and
backups, in the change feed, no growth bound (one row per step a person takes).

```ts
chord_unlocks(
  position integer primary key,   // 2, 3, 4… — level 1 is the constant below
  step jsonb not null,            // parsedJson, discriminated:
                                  //  { kind: "chords", stage, tokens[], modes[] }
                                  //  { kind: "ask", rule: "half" | "all" }
  unlockedAt timestamptz not null
)
```

Level 1 is a constant in `curriculum/core` (`FIRST_LEVEL`: I, IV, V, major,
rule `target`) — it replaces `STARTING_CHORDS` / `STARTING_MODES`, which leave
`vocabulary/core`. Unlocked chords = `FIRST_LEVEL` ∪ the rows' tokens; modes and
the ask rule likewise. Storing the *step* rather than a stage index means a
later edit to the stage list cannot rewrite what the learner already unlocked.

## Server surface (`curriculum` plugin)

- `chord.curriculum` — live resource, `mode: "invalidate"`, identity table
  `chord_unlocks`. Value: `{ level, askRule, modes, unlocked: { token, level }[],
  stage }`. Cheap: a scan of a handful of rows.
- `POST /api/chord/curriculum/next` → `{ kind: "not-ready", status } |
  { kind: "step", step, windows } | { kind: "done" }`. This is the expensive
  read (one `next-chords` scan plus a count per unopened stage), so it is an
  endpoint, not a live resource: putting it on the index tables would recompute
  it hundreds of times during a load.
- `POST /api/chord/curriculum/unlock`, body `{ expected: NextStep }` — the
  server recomputes the next step and refuses with a conflict when it differs
  from what the learner was shown (the index moved). No client-invented steps.
- `POST /api/chord/curriculum/undo` — drops the last row; refuses when there is
  none. So a mis-click is recoverable.

`song-index/server` gains two exported query functions for this —
`countLoopsByNextChord` (already written, now also counted **per key mode** in
one scan, so a stage sums only its own modes) and a new `countLoopsInSet` — and
the curriculum calls them directly. HTTP between two server plugins would be the
wrong seam. The `next-chords` endpoint stays as the index's public read (the
song-index e2e script measures it); its response rows become
`{ token, byMode: Record<HookpadMode, number> }` — no `windows` total, which
would be a number no caller can use without knowing the modes. Nothing consumes
the endpoint today, so the reshape breaks nothing.

## What the learner sees

The mockup's two surfaces, plus one new box state.

- **Given boxes** in the answer strip: the chord's numeral in its colour, dimmed
  and flat (no fill, no selection, not a click target), so the strip reads as
  "these are the ones I have to name". The heading counts asked boxes only:
  "Chord 1 of 2", then "2 of 2 right in 1.4 s".
- **The locked next chord** in the chord-button grid: the mockup's ghost pad —
  the numeral with a lock and "Level 5", or **Add it** in the accent colour once
  everything is mastered (`chordMastery` over the unlocked set, from the live
  progress resource — no new rule).
- **The panel's locked row** under "Your chords": the same step as a row, with
  **Add** when ready. An ask-rule step has no chord, so it shows only here, as
  "Name the whole cadence" / "Name the whole loop" with the same button. The
  ghost pad stays chord-only, as in the mockup.
- **Order.** The button grid stays in degree order (keys 1–7 left to right,
  muscle memory); "Your chords" lists in unlock order, so the newest chord sits
  just above the locked next one.

### Keys

`vocabulary/core` gains, replacing `chordShortcutKey` (which answers `null` for
every chromatic root — ♭VII has no degree in the major scale, but it is
obviously the 7 key):

```ts
chordDigit(token): "1".."7"            // the root's letter degree: ♭VII → 7, ♯IV → 4
chordKeyPlan(unlocked): { digit, tokens[] }[]   // in degree order, tokens in unlock order
```

One chord on a digit answers on the first press. Several: the press lights that
digit's pads, numbered 1…n, and the next key picks one (Esc cancels). The pads
show "5" or "5 2" accordingly. The answer clock stops on the key that fills the
box, so a two-stroke answer costs what it costs — that is honest, and it is a
reason the curriculum keeps the palette small.

## Layout

```
plugins/apps/plugins/chord/plugins/curriculum/
  core/    stages.ts (the table above + classification), ladder.ts (choose the next
           step, pure over counts), ask.ts (askedPositions, FRESH_ANSWERS),
           first-level.ts, endpoints.ts, resource.ts (+ tests)
  server/  internal/tables.ts (chord_unlocks), state.ts (the resource loader),
           next.ts (counts → ladder), handlers.ts (unlock / undo / next)
  web/     useCurriculum(), useNextStep(), useUnlockStep(),
           <NextStepPad>, <NextStepRow>
```

Touched:

- `vocabulary/core` — `chordDigit`, `chordKeyPlan`; `STARTING_CHORDS` /
  `STARTING_MODES` and `chordShortcutKey` removed.
- `trainer/core` — `roundFromCandidate` marks each box asked or given
  (`askedPositions`); `sheet.ts` pre-fills given boxes and locks them (selection
  skips them, the check waits only on asked boxes, `sheetScore` and
  `recordRoundBody` count asked boxes only).
- `trainer/web` — the unlocked set and modes come from `useCurriculum` (the
  screen shows a loading state until it and the progress have landed, never an
  empty palette); the two-stroke key handling; the given-box paint in
  `answer-strip.tsx` + `trainer.css`; `<NextStepPad>` in the button grid;
  `<NextStepRow>` and unlock-order listing in `progress-panel.tsx`.
- `progress` — `chord_rounds` gains `givenCount` (default 0; older rounds had
  none). Answers are still written for asked boxes only, so mastery counts only
  chords the learner actually named.
- `song-index` — per-mode counts in `next-chords`, `countLoopsInSet`, both
  exported from the server barrel.

Dependencies stay one-way: `trainer → curriculum → vocabulary → song-index`.

## Build order

1. `curriculum/core`: stages + classification, the ladder chooser (pure, over
   supplied counts), `askedPositions`, `FIRST_LEVEL`, endpoint and resource
   contracts. Tests: every token from the sample's top 45 lands in the expected
   stage; the chooser stays in a stage until it runs dry, then jumps to the best
   entry; ask rules including the empty-selection fallback.
2. `song-index`: per-mode `next-chords`, `countLoopsInSet`, barrel exports; a
   `find-db`-style DB test for both.
3. `curriculum/server`: the table, the state resource, `next`, `unlock` (with
   the conflict check), `undo`; a `worktree-db` test of a full ladder walk.
4. `trainer/core`: asked/given boxes through the round and the sheet (+ tests:
   a given-only round is impossible, the check waits on asked boxes only, the
   recorded body carries asked boxes only).
5. `progress`: `givenCount`.
6. `trainer/web` + `curriculum/web`: the palette from the curriculum, the
   two-stroke keys, the given-box paint, the teaser pad and panel row, Add /
   Add anyway / Undo.
7. CLAUDE.md for `curriculum`, and updates to `chord`, `vocabulary`, `trainer`,
   `progress`, `song-index`.
8. Track page: an update card and the progress list; then the follow-up task
   with the page id and `block-361815ed-5750-413a-b5ab-31c5dc855144`.

## Verification

1. `./equin test plugins/apps/plugins/chord` — the units above.
2. `./equin build` (background): migrations, boundaries, type-check, docs.
3. `./equin run plugins/apps/plugins/chord/plugins/curriculum/e2e/ladder-preview.ts`
   — a new script that walks the ladder against the deployed index and prints
   the first ~20 levels with their window counts. This is how the order gets
   reviewed by eye ("does minor really come before 7ths?"), and it is the check
   that the ranking is grounded in the songs, not in my taste.
4. `e2e/curriculum-verify.ts` (in `curriculum/e2e`): from a fresh DB the trainer
   shows three chord pads and a round with exactly one asked box; filling it
   checks the round; **Add anyway** raises the ask rule and the next round has
   more asked boxes; a chord step adds a fourth pad and the next round asks only
   its boxes; `query_db` shows the `chord_unlocks` rows and `chord_rounds.given_count`.
5. Screenshot `/chord` (`screenshot.ts --path /chord`) for the given-box paint
   and the locked teaser, light and dark are the same (the app is dark only).
6. By hand: the two-stroke key on a digit with two chords, and Undo.

## Left open

- **Inversions need their root-position twin**, so the `inversions` pool is
  empty until, say, V is unlocked — which it always is. If a twin is somehow
  missing the chord simply never ranks; no special case.
- **The end of the ladder.** When no stage has a candidate above the threshold,
  `next` answers `done` and the panel says so. With the full index that is far
  away; on a 5 % sample it may arrive, which is fine.
- **Re-locking a chord** (it turns out too hard) is not offered — only Undo of
  the last step. If the learner wants it, it is a later step.
- **The modal stages** (mixolydian, dorian, …) open a mode and no chord, so the
  teaser has no numeral to show; it shows the mode's name. Worth a look on
  screen when one first appears.
