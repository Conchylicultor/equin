# progress

What the chord trainer remembers about the learner: every round they check,
the answer they gave for each box, and the stats the side panel shows. Design:
`research/2026-09-18-apps-chord-trainer-app.md` ("Progress").

## Using it

```ts
// The trainer, once every box it asked for is filled. One transaction.
POST /api/chord/rounds
  { sectionId, videoId, shape, startBeat, givenCount, blanks,
    answers: [{ position, token, answer: ChordToken | "rare", answerMs }] }   → { roundId }

// The panel: the standing of each chord on, the rare chords pooled, today, and all time.
const params = encodeProgressParams({
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  tokens: listedOn,
  rare: practisedUnlisted,   // [] → `rare: null`
});
const progress = useLive(chordProgress, params);

// The rule, for anyone who needs it on the client too.
chordMastery(answersMostRecentFirst) → { answers, correct, accuracy, medianMs, mastered }
```

- **Right or wrong is decided by the server** (`isRightAnswer(token, answer,
  listed)`): the chord itself, or the **Rare joker** (`answer: "rare"`) for a
  chord the catalog does not list — read through the curriculum's server
  export `isListedChord`, asked only about boxes answered Rare (it needs the
  index ready, as the round's loop did). A listed chord named for a rare one,
  or Rare for a listed one, is wrong. The client never sends the verdict;
  `boxCount` and `correctCount` on the round come from the same decision, and
  the trainer scores its sheet with the same `isRightAnswer`.
- **Answer times** must be whole ms in `MIN_ANSWER_MS`…`MAX_ANSWER_MS`
  (300 ms – 30 s). The trainer clamps; the endpoint refuses anything outside.
- **A round asks for only some of its boxes.** The curriculum scaffolds the
  rest: they are shown already filled and the learner never names them. So
  `answers` carries the asked boxes only, `givenCount` the rest, and
  `boxCount` on the round means **boxes answered** — the loop had
  `boxCount + givenCount`. Positions are distinct boxes of the loop
  (`0…boxCount + givenCount − 1`), not `0…n-1`.
- A round skipped before it was checked is never sent, so it never counts.
- `songs` (today and all time) still counts rounds, scaffolded or not.

## The mastery rule

`chordMastery` reads a chord's answers **most recent first** and looks at the
first `MASTERY_WINDOW` (20). A chord is mastered when all 20 exist, at least
`TARGET_ACCURACY` (90 %) are right, and their median time is at most
`TARGET_MEDIAN_MS` (2 s). For an even count the median is the mean of the two
middle times. Fewer than 20 answers is never mastered. The server feeds it
each chord's last 20 answers; the panel shows what comes back.

## `chord.progress`

`chordProgress`, a `liveValue` with `params: ["timeZone", "tokens"]` (so its
params are `ChordProgressParams`: two strings). `tokens` is a chord set sorted
(plain string order), deduplicated and joined by commas, so one set is one
subscription. Build params only with `encodeProgressParams`:
`decodeProgressParams` (which the loader runs) throws on an unknown time zone,
on a malformed token, and on any other spelling of a set. `chords` comes back
in that sorted order; a panel that wants its own order sorts it itself.

**The params never depend on the learner's selection.** The trainer asks for
every LISTED chord of the catalog (`listedTokens`), so its subscription is keyed
on the catalog alone: toggling a chord never re-keys the read, which would send
it back to `pending` (the panel's loading state, no `desired` for the queue — a
flash on every chip click).

`rare` is ONE pooled `MasteryStanding` over the last 20 answers given for any
chord the catalog does NOT list — decided by the server, from the curriculum's
`loadListedChords`, not by the params — or null when no rare chord was ever
answered: the Rare row of "Your chords", and the rare chords' desired share of
loops. One query walks `chord_answers_answered_at_idx` backwards, skipping the
listed set (one array param), until it has 20 rows. While the song index is
not loaded there is no catalog to say what is rare, and the loader **throws**
rather than guess; the trainer subscribes only once `chord.catalog` is ready.

- **Per chord**: one lateral index scan of `(token, answered_at desc,
  position desc)`, `LIMIT 20` per token — for every listed chord (a few hundred
  on the full index), each a short index probe.
- **Today**: since the local day began in `timeZone`, from
  [`startOfLocalDay`](../../../../../packages/plugins/wall-clock/CLAUDE.md), so
  the host's zone never matters — including on the two days a year the clocks
  move, where the day may begin at 01:00 rather than midnight, or at the first
  of two midnights. `songs` counts checked rounds.
- **All time**: plain counts, which grow with the history. At one learner's
  scale that is small; revisit with a rollup if it ever is not.

Server: `serveValue({ source: "db" })`. The change feed routes every committed
write to the tables the loader read (`chord_answers`, `chord_rounds`) here,
and each subscribed (time zone, chord set) tuple is recomputed and pushed. One
object whose `chords` holds one entry per requested token, so the params bound
it. There is no placeholder: `useLive` answers `pending` until the server's
first value.

## Tables

- `chord_rounds`: one checked round (section, video, loop shape and start beat,
  check time, answered and right counts, and `given_count` — boxes shown
  filled in, 0 for every round checked before the curriculum). Indexed on
  `checked_at`.
- `chord_answers`: one box (`position`, the `token` that played, the `answer`
  picked — a token or `rare` —, `correct`, `answer_ms`, `answered_at`, and
  `blanks`, a `RecordedBlanks`: the setting it was asked under, `one` for the
  path's single box, null before the setting existed). FK to the round,
  cascade. Indexed on `(token, answered_at desc, position desc)`, on
  `answered_at`, and on `round_id`; the `(token, blanks, …)` index the path
  read stays, unused.

`answered_at` is the round's check time: the trainer reports how long each box
took, not when it was filled. Inside a round, `position` orders the answers,
which is why it is the index's third key.

`start_beat` is a double, like `chord_loop_windows.start_beat`, so a round
names its loop exactly. There is no foreign key to `chord_sections`: that
table is a cache the song index rebuilds, and the history must outlive it.

Both tables are **kept** in worktree forks and in backups — they are the
learner's history, which nothing can rebuild — and **stay in the change feed**,
which drives `chord.progress`. **No growth bound is declared**: rows are
written only when a person checks a round, so they grow only as fast as
someone plays, and the retention monitor's silencing set must only hold bounds
that are real.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Chord progress: the chord_rounds / chord_answers history, the endpoint that saves a checked round, and the live chord.progress stats (each chord's last 20 answers against the mastery rule, today in the learner's time zone, all time).
- Server:
  - Contributes: `resource.declare` "chord.progress"
  - Uses:
    - `apps/chord/curriculum.isListedChord`
    - `apps/chord/curriculum.loadListedChords`
    - `apps/chord/song-index._chordIndexRequest`
    - `apps/chord/song-index._chordIndexState`
    - `apps/chord/song-index._chordLoopWindows`
    - `database.db`
    - `database/sql-column.parsedText`
    - `infra/endpoints.implement`
    - `network/live.serveValue`
  - DB schema: `plugins/apps/plugins/chord/plugins/progress/server/internal/tables.ts`
  - Resources: `chord.progress` (push)
  - Routes: `POST /api/chord/rounds`
- Core:
  - Uses:
    - `apps/chord/curriculum.BlanksSchema`
    - `apps/chord/song-index.ChordToken`
    - `apps/chord/song-index.ChordTokenSchema`
    - `apps/chord/song-index.LOOP_SHAPE_IDS`
    - `infra/endpoints.defineEndpoint`
    - `integrations/hooktheory.TheorytabSectionIdSchema`
    - `network/live.liveValue`
  - Exports (types):
    - `Answer`
    - `ChordAnswerSample`
    - `ChordMastery`
    - `ChordProgress`
    - `ChordProgressParams`
    - `ChordStanding`
    - `DecodedProgressParams`
    - `MasteryStanding`
    - `RecordRoundBody`
    - `RoundAnswer`
  - Exports (values):
    - `AnswerSchema`
    - `chordMastery`
    - `chordProgress`
    - `ChordProgressSchema`
    - `ChordStandingSchema`
    - `decodeProgressParams`
    - `encodeProgressParams`
    - `isRightAnswer`
    - `MASTERY_WINDOW`
    - `MasteryStandingSchema`
    - `MAX_ANSWER_MS`
    - `MIN_ANSWER_MS`
    - `RecordRoundBodySchema`
    - `recordRoundEndpoint`
    - `RoundAnswerSchema`
    - `TARGET_ACCURACY`
    - `TARGET_MEDIAN_MS`
- Cross-plugin:
  - Imported by: `apps/chord/trainer`
- Exemptions:
  - Exempts itself from: `ids:pk-declared` — `server/internal/tables.ts` (debt)

<!-- AUTOGENERATED:END -->
