# Chord trainer: free, data-driven chord selection (replaces the Path)

Look: prototype `proto-1791276393-29e2` (option `data = index`). Supersedes the
path half of `research/2026-09-23-apps-chord-trainer-free-curriculum.md`.

## Context

The Path card (hand-written chapters × blanks, cells, "on the route") is too
rigid. The learner wants to choose exactly which chords they train, from any
harmony, and narrow practice to a subset, while still getting a hint about what
to learn next. The order and grouping come from the song index, not from
hand-written lists. How often a chord turns up follows its mastery, so the
learner no longer gets one forced target per loop.

Decided with the user (2026-10-06):

- The Path card is replaced by a new **collapsible "Chords" section** in the
  trainer's side panel. The Today and All-time stats and the "Your chords"
  per-chord progress list **stay as they are**. There is no Train button, and
  every change applies from the next loop.
- **Key modes leave the selection.** The chords alone decide which loops fit,
  whatever key the song is labelled in.
- **Rare chords are answered with one joker button, "Rare".** It is the right
  answer for any chord that is *not listed* in the catalog (a rare-group or
  Other chord).

## Model

### Selection (`curriculum/core/selection.ts`)

```ts
Selection = {
  chords: { token, state: "practice" | "hear" }[],   // off = absent (unchanged)
  blanks: "all" | "random" | "half",                 // All / Random half / Last half
  extras: 0 | 1 | 2 | "any",                         // Other chords per loop (default 0)
}
```

- `modes` is gone. `firstSelection()` becomes I, IV and V practised, blanks
  `half`, extras 0.
- **Blanks.** `half` keeps its id and its meaning: the practised boxes in the
  second half, which is now labelled "Last half". `random` is new: half of the
  practised boxes, rounded up, chosen at random when the loop is dealt. `one` is
  no longer settable. Recorded answers still hold `one`, so
  `RecordedBlanksSchema = BLANKS ∪ "one"` types `chord_answers.blanks`, and the
  settable `BlanksSchema` is the curriculum's.
- **`askedPositions`** loses `target`. Its rules become `all`, `half` (falling
  back to the last practised box, as today) and `random` (takes an RNG, so the
  tests can fix it). An unlisted practised chord is asked like any other.

### Catalog (new): tracks, sections and chords from the index

`curriculum/core/catalog.ts` is pure:
`buildCatalog(sets: { mode, tokens, windows }[]) → Catalog`.

- **Tracks are data**, each with its scope of key modes and an ordered list of
  section *rules*:
  - Major (scope `major`).
  - Minor (scope `minor`).
  - Modal: one section per mode, each scoped to its own mode (mixolydian,
    dorian, lydian, phrygian, locrian, harmonicMinor, phrygianDominant).
  - Sevenths & jazz (scope `major`; only chords with four or more tones).
- **Section rules are predicates over `ChordTokenParts`.** They reuse the
  scale-shape helpers already in `stages.ts`, which this change moves into
  `catalog-rules.ts`. Sections are Core, Diatonic sevenths, Inversions (a chord
  whose root-position twin belongs to a diatonic family), Colour, Secondary
  dominants, Borrowed, Harmonic minor, Diminished & passing, and so on. Within
  a track the first rule that matches owns the chord.
- **Every chord in the index lands somewhere.** A token that no rule in a
  track's scope matches goes to that track's **Other** section, and a test
  asserts that every token is accounted for.
- **Numbers.**
  - A chord's share is the windows in the section's scope that hold it,
    divided by all windows in that scope.
  - A section's coverage is the windows holding at least one of its chords.
  - Sections are ordered by coverage, with Core always first and Other always
    last.
  - Chords are ordered by share.
- **Rare and listed.**
  - A chord is **listed** when its share is at least 1%, when it is in Core
    (always shown complete), or when its section has 2 or fewer rare chords
    (those are listed instead of collapsed).
  - Every other chord goes into the section's `rare: { tokens, share }` group.
  - `isListed(catalog, token)` is true if any track lists the token. It is
    what decides whether the Rare joker can answer a chord.
- **Hints and badges.**
  - `suggestedNext(track, selection)`: in a track with at least one chord on,
    the listed chord with the highest share that is still off. It is a hint
    only.
  - `trackStarted` and the "+N rare" display are derived from the selection
    against the catalog. The catalog stores no per-group state; a group's chip
    shows the state all its tokens share, or "mixed".
- **Size.** The `rare.tokens` member lists ship to the client: 1,808 distinct
  tokens on main, about 25 KB. With them the client can compute group state and
  send group writes.

**Server.**

- A new song-index server export, `countTokenSets({ shape })`, runs
  `SELECT key_mode, chord_tokens, count(*) … GROUP BY 1,2`. On main that is
  83,752 rows over 183,270 windows.
- `curriculum/server` serves the live value `chord.catalog`:
  `{ kind: "not-ready" } | { kind: "ready", catalog }`, through
  `serveValue({ source: "db" })`.
- The loader first reads `loadIndexStatus()`. While the index is not ready it
  returns `not-ready` at once, so the many progress writes during a load cost
  nothing. Once the index is ready it builds the catalog, memoized by the
  ready status's identity (snapshot, scope and derivation version). The
  `chord_index_state` change feed pushes the value when a load finishes.
- The loader must not answer an empty catalog in place of "not loaded".

### Writes (`curriculum/core/endpoints.ts`)

The four endpoints become three:

```ts
POST /api/chord/curriculum/chords  { changes: { token, state }[] }  // one chord, a section, a rare group, Clear, Undo
POST /api/chord/curriculum/blanks  { blanks }
POST /api/chord/curriculum/extras  { extras }
```

- One delta endpoint covers every chord change, applied atomically by
  `updateSelection`.
- **Clear** sends every on chord as `off`. **Undo** (a toast-length button in
  the section header) replays the snapshot taken before the Clear as one
  `changes` call.
- `chapter` and `cell` go away with the path.

**Table.** The `chord_curriculum` table drops `modes` and adds `extras`
(jsonb, default 0). `blanks` stays a text column. The loader maps a stored
`one` to `half`, keeping the column's schema as `BLANKS ∪ "one"` and
normalising on read. The migration is generated by `./equin build`.

## Loop selection: mastery-driven share, no forced target

`trainer/core/loop-share.ts` (new, pure) replaces `target.ts`:

- `desiredShare(standing)` gives the share of loops a practised chord should
  appear in:
  - 0.50 while new (no answers);
  - falling to 0.15 as `answers/20 × accuracy` grows;
  - 0.15 once mastered, never 0.
  - Unlisted (rare) practised chords share one pooled standing (below).
- `pickNext(pool, history, desired) → LoopCandidate`: from a candidate pool,
  choose the loop that most reduces the squared gap between each practised
  chord's observed share and its desired share. The observed share comes from
  the last 20 dealt loops plus a prior, so the first loops are not extreme.
  Ties are broken at random.

**Server.** `find` drops the required `target`:

```ts
FindLoopsBody = { playable, practised, extras, focus?, excludeSectionIds?, shape, limit }
```

- Every window must contain at least one practised chord (`chord_tokens &&
  practised`, from the GIN index).
- Every other chord in the window must be playable, or there may be up to
  `extras` chords outside the playable set:
  - extras `0` keeps today's `<@ playable` (GIN);
  - `1` and `2` add `cardinality(chord_tokens minus playable) ≤ n`;
  - `any` drops the containment test.
- `focus?` (`@>`) asks for windows that hold one chord.
- `unlockedWindowsWhere` grows the same options, so `countLoopsInSet` still
  agrees with `find`.
- `modes` is removed from `find`, but kept on the count reads, which the
  catalog does not use.
- **To measure:** extras `1` and `2` scan like `next-chords` (~90–120 ms).
  Measure p95 in `song-index-verify.ts` before accepting it.

**Client (`use-loop-queue.ts`).**

- The queue holds a **pool**. When it runs low it fetches, in parallel, one
  unfocused batch plus focused batches for the (at most 2) chords with the
  largest share deficit.
- Each next loop is `pickNext(pool, history, desired)`. A queued loop no longer
  carries a target.
- **The round on screen is frozen.**
  - Its asked positions are computed once, when the loop is dealt (blanks
    `random` included), and stored with the queued loop.
  - The round key no longer includes the selection, so a change never deals
    the on-screen loop again. This replaces today's rule of re-dealing it or
    dropping it when a chord in it is turned off.
  - Any selection change drops the pool behind the round.

## Rare joker

- **Answer strip** (`chord-buttons.tsx`). Practised **listed** chords keep
  their buttons. When at least one unlisted chord is practised, one extra
  **Rare** button appears; it is always present then, so it never gives the
  answer away. It gets a key: the next free digit, or `0`.
- **Wire format.** `answer` becomes `ChordToken | "rare"` (`AnswerSchema` in
  progress/core). `chord_answers.answer` widens to that text schema.
- **Who is right is decided by the server.** `answer === token`, or
  `answer === "rare" && !isListed(catalog, token)`. The progress server reads
  the catalog through a curriculum **server** export (`isListedChord`), which
  needs the index to be ready, as a round's loop already does. Checked: there
  is no import cycle, since curriculum does not depend on progress.
- **A wrong answer.** A box answered Rare that was a listed chord shows the
  real chord, as today. A listed answer given for a rare chord is simply wrong.
- **Pooled standing.** `chord.progress` gains a `rare` param: the practised
  unlisted tokens, encoded like `tokens`. It answers one pooled
  `ChordStanding` over their last 20 answers combined, and returns null when
  the param is empty.
  - The pool drives the Rare row in "Your chords" and the desired share of the
    rare chords.
  - `byBlanks` (path-only) is removed from the schema and from the query; the
    `token, blanks` index stays harmless.

## UI (curriculum/web, rendered by trainer's `ProgressPanel`)

`<ChordsSection selection catalog progress/>` replaces `<PathCard>`. It is a
`section-card` style collapsible titled "Chords", folded state remembered
locally (`persistent-draft`). Open, top to bottom:

1. **Header actions:** "✓ from the next loop" flash, and Clear / Undo clear.
2. **Blanks:** All · Random half · Last half, each with its loop glyph.
3. **Other chords per loop:** None · 1 · 2 · Any.
4. **Tracks:** a collapsible accordion (Major open by default), as in the
   prototype.
   - **Track head:** badge, name, "N practised · N heard · +N rare" or "not
     started", chevron, and a thin coverage bar once started.
   - **Body:** sections. Each section head shows its name and a None / Hear /
     Practise control **on hover or focus only**.
   - **Chips:** all the same height (`<ChordNumeral>`, `chordToneStyle`). A
     click cycles off → hear → practise. Mastered chips show ✓, chips being
     learned show a mini meter, and the suggested-next chip is outlined.
   - **Rare chip:** one "+N rare" chip per section (or "N other chords" for
     Other), which cycles the whole group.
5. **Fixed-height footer:** a legend at rest; on hover, the exact numbers (the
   chord's share in its scope with its tier, which other tracks hold it, its
   state, its mastery, and about what share of your loops it gets).

No percentages or totals at rest. A **pending catalog** (or `not-ready`)
renders the section's loading state, never empty tracks.

**"Your chords" list (unchanged look).** It is ordered by catalog order (track,
then section, then share) instead of path order, plus one **Rare** row (pooled
standing) when unlisted chords are practised. `<PathProgress>` is removed.

## Deletions

- `curriculum/core/path.ts`, `path.test.ts` and `stages.ts` (its rules move
  into the catalog rules); `change.ts`'s `withChapterState`.
- Web: `path-card.tsx`, `path-progress.tsx` and `path.css`.
- Endpoints: `chapter` and `cell`.
- Trainer: `target.ts` (`weakestChord`).
- Progress: `byBlanks`.
- `curriculum-verify.ts` is rewritten.
- `CLAUDE.md`s for curriculum, trainer, progress and song-index are updated.

## Critical files

- `plugins/apps/plugins/chord/plugins/curriculum/{core,server,web}/…`: the
  selection, catalog, catalog rules, endpoints, `state.ts`, `tables.ts`, the
  new `catalog-resource`, and `chords-section.tsx`.
- `…/song-index/server/internal/find.ts`, `core/endpoints.ts`: find without a
  target (playable/practised/extras/focus), and `countTokenSets`.
- `…/trainer/core/{loop-share.ts, round.ts, sheet.ts}` and
  `trainer/web/internal/use-loop-queue.ts`: the frozen asked positions.
- `…/trainer/web/components/{progress-panel.tsx, chord-buttons.tsx,
  trainer-screen.tsx, answer-strip.tsx}`.
- `…/progress/{core/progress.ts, core/endpoints.ts, server/internal/progress.ts,
  record.ts, tables.ts}`: the joker, the pooled standing, and dropping
  `byBlanks`.

## Verification

- **Unit tests** (`./equin test plugins/apps/plugins/chord`):
  - `buildCatalog`: every token placed exactly once per track scope; Core
    complete; ordering; rare collapse and the ≤ 2 rule.
  - `askedPositions`: `random` and `half` cases.
  - `desiredShare` and `pickNext`: over a simulated stream, a new chord
    converges toward ~50% and a mastered one toward ~15%.
  - The selection changes.
  - The progress DB test for the joker's correctness and the pooled standing.
  - `findLoopsWhere` SQL shape for each extras value.
- **Catalog against the real index:** check the real numbers against main's
  index. Major has about 46 listed chords; vii° sits at about 0.55% in Core;
  ii7, vi7 and I6 rank above V7.
- **e2e:** rewrite `curriculum/e2e/curriculum-verify.ts` to:
  - open Chords, then set Blanks All / Random / Last and check the next round
    asks accordingly;
  - cycle a chip (its answer button comes and goes);
  - set a section and a rare group (the Rare button appears);
  - set Other chords = 1 and check a later round may hold a given chord that is
    off;
  - Clear, then Undo;
  - check the on-screen round's boxes never change on an edit;
  - restore the selection.

  Then run `trainer-verify.ts`.
- **Visual:** `compare-diff.ts --name proto-1791276393-29e2 --options data=index`
  against `/chord`, after `./equin build`.
