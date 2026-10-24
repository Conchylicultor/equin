# The send watermark: a turn's confirmation is a property of the row, not of when we first looked

## Context

`pending-turn` answers one question: *did my message reach the agent?* It answers it
by matching the record's normalized text against the session JSONL. Right now it can
answer **no about a message the agent already replied to** — and the user, told the
send may have failed, sends it again.

That happened. In `conv-1786969506-7e03` a turn was delivered at
`2026-08-19T00:21:12.991Z` (line 1109 of `baf9c302-….jsonl`; the agent answered it at
line 1122), and the record still tripped its 90 s deadline at `00:22:43.78`. The
warning card stayed on screen saying *"the agent may not have received this message"*,
so the user pressed Retry, and the identical text was delivered a second time on Aug 20
(line 2189, a different `uuid` and `promptId`). **The duplicate message in that
conversation is real — the viewer is faithful.** The transcript genuinely holds the
prompt twice because we asked the user to send it twice.

This is not a one-off: **18 `turn-unconfirmed` reports across 18 distinct conversations
and 23 episodes** since Aug 16, with previews from all three deliveries — `"Go"`,
`"continue"`, `"Answering your questions:…"`, `"Please wrap up this conversation:…"`.

### Root cause

`matchPendingTurns` (`web/internal/reconcile.ts`) stamps the baseline in the **same
pass** that it matches:

```ts
if (rec.baselineUserText == null) rec = { ...rec, baselineUserText: userTexts.length };
const baseline = rec.baselineUserText ?? 0;
...
userTexts.find((u) => u.ordinal >= baseline && !consumedUser.has(u.ordinal) && u.normalized === target)
```

The stamp is `userTexts.length`; the highest ordinal is `length - 1`. So **nothing
present at stamping time can ever match**, by construction. On the normal path the
store's `commit → notify → render → effect` chain runs a pass *before* the CLI writes
the line, so sending usually works. When that first pass is deferred past the turn's own
arrival — a hidden or throttled tab, a render batch carrying both the new record and the
new events, a second tab whose `refreshFromStorage` commits last — the row it stamps
past **is the delivery**. `retryPendingTurn` (`store.ts:428`) resets the baseline to
`null`, so a Retry re-enters the same trap.

The defect is not the value of the baseline. It is that **eligibility depends on when
the matcher first ran**: `matchPendingTurns` keeps memory about its own call history, so
the same `(record, transcript)` pair yields different answers depending on scheduling.
Choosing a better stamp cannot fix that. Deleting the memory can.

A second, independent reason the representation is wrong: an ordinal is a coordinate in
a set that is recomputed on every parse. `activeLineUuids` keeps only each tree's
leaf→root path, so a line can leave and re-enter the active spine; chain merges, forks
and `/compact` all reshape the array. Timestamps are per-line and immutable.

## The change

**Bind only rows written at or after the instant the send was dispatched — and that
instant is `createdAt`, which the record already carries.**

`createdAt` is `Date.now()` set synchronously in `sendConversationTurn` *before*
`runDelivery` is dispatched. It is exactly the watermark we need, it is present on 100 %
of persisted records, and using it means **one field removed and none added**.

Three consequences worth stating up front, because each is load-bearing:

1. **Do NOT add a new required field.** `readPendingTurns` (`persist.ts:14-24`) is an
   unchecked `JSON.parse(...) as Envelope<T>`. Records live in localStorage for 7 days
   and are adopted across tabs. Any field added today is `undefined` on every record
   already on disk, and a numeric comparison against `undefined` is `false` — every
   pre-existing record would become permanently unmatchable. "Required ⇒ unspellable"
   holds inside TypeScript and is **false across `localStorage`**. Deriving from
   `createdAt` needs no migration at all.
2. **Retry must NOT move the watermark.** `reconcile.ts` already holds that the
   transcript is ground truth *in both directions* — a `failed-post`/`unconfirmed`
   record whose text is in the transcript "was delivered". If the original send landed
   and we merely failed to see it, the record should retire on **that** row; that is the
   truth the card owes the user. If it did not land, no such row exists and the retry's
   own row matches anyway. Keeping the original `createdAt` is strictly more correct and
   makes the field immutable for the record's whole life.
3. **The matcher stops writing bookkeeping.** With the stamp gone, a returned record
   differs from its input only by a state transition. `matchPendingTurns` becomes a pure
   function of `(records, events, now)` with no dependence on call history — and a pass
   that matches nothing becomes genuinely inert (today every fresh record's first pass
   forces a commit + notify).

### Clocks

Browser and CLI read the same machine's wall clock, and the record exists strictly
before the CLI can write the line — in the incident, 0.79 s of submit-verification tail
remained *after* the row was written (`elapsedMs 96303` against the 90 s deadline). So a
turn's own row is always at or after its `createdAt`.

Allow **1 s** for sub-second jitter (`CLOCK_SKEW_ALLOWANCE_MS`), named a *skew
allowance*, not a matching window. The asymmetry decides the size: excluding your own
row costs a false `unconfirmed`, a Retry on false information and a duplicate message
delivered to the agent — the observed incident. Matching a *prior* identical row costs a
silent false "delivered", which is worse but requires an identical text within the
allowance window. Short repeat-prone sends (`"Go"`, `"continue"`) are common, so the
window must stay far below any plausible human re-send interval. 1 s satisfies both.

> **Alternative considered and rejected:** a watermark read from the transcript's own
> clock (the `at` of the last row seen at send time), which avoids comparing two
> processes' clocks entirely. It needs a new persisted field (see point 1 above), needs
> the pane to feed the store a watermark even when no records are pending
> (`jsonl-pane.tsx:185` early-returns today), and still has a same-millisecond boundary
> question. Not worth it against a 1 s allowance on a value we already store.

> **Also rejected: a correlation token** we author into the turn text (the
> `wrapPreprompt` / `ANSWER_MARKER` precedent). It cannot cover `push-and-exit` (the
> server composes those bytes from config) or `ask-user-question-answer`, so the very
> abstraction this plugin exists to hold would leak on day one; it cannot cover the
> `queue-operation` enqueue fallback; and it is paid for in the model's context, the
> user's terminal, `/resume` history and a second stripping contract — forever, on every
> turn, to answer a question the wall clock answers for free.

## Implementation

### Step 0 — make `at` parseable by construction (separable)

`plugins/conversations/plugins/transcript-watcher/server/internal/parse-jsonl.ts:361-362`

The parser already drops lines whose `timestamp` is not a string. Extend the same guard
to reject a string that does not parse, so `JsonlEvent.at` is a *parseable* instant for
every consumer. `Date.parse("garbage")` is `NaN` and `NaN >= x` is `false` — an
unguarded matcher would silently never match, which is today's bug wearing a new hat.
Fix it at the source rather than with a throw in the matcher (which would crash the pane
over one malformed line). `jsonl-pane.tsx` already produces `NaN` from the same input
today, so the guard fixes more than this plugin.

Test: one case in `parse-jsonl.test.ts` — a line with `timestamp: "not-a-date"` emits no
event.

### Step 1 — `pending-turn/web/internal/store.ts`

- `PendingTurnRecord` (~line 109): delete `baselineUserText: number | null`. Rewrite the
  `createdAt` doc to state **both** jobs and the immutability rule — TTL origin *and*
  transcript watermark, never moved, including across Retry.
- `sendConversationTurn` (~line 392): delete `baselineUserText: null`. Add a one-line
  comment above `createdAt: Date.now()` saying it is the watermark, because "move this
  after the POST" would otherwise look harmless.
- `retryPendingTurn` (~line 427): delete `baselineUserText: null` **and** the
  "Re-stamped on next reconcile…" comment. Replace it with the opposite rule stated
  explicitly — deleting a line documents nothing.

Nothing else changes: `sweepPendingTurns`, timers, reports, FIFO overflow and
`deliveryFor` are untouched.

### Step 2 — `pending-turn/web/internal/reconcile.ts` (the whole functional change)

1. Export `CLOCK_SKEW_ALLOWANCE_MS = 1_000` beside `CONFIRM_DEADLINE_MS`, documented as
   above.
2. One private helper as the single definition of eligibility:
   `matchWindowStart(rec) => rec.createdAt - CLOCK_SKEW_ALLOWANCE_MS`.
3. Candidate arrays carry `{ atMs: Date.parse(event.at), normalized }` — drop the
   hand-rolled `ordinal`, the array index already is it and is already the consumed-set
   key. Collect for `user-text` **and** for the `queue-operation`/`enqueue` branch.
4. `takeUserText(target, since)` and `takeEnqueue(target, since)` both become a
   `findIndex` over `(c, i) => c.atMs >= since && !consumed.has(i) && c.normalized === target`.
   **`takeEnqueue` gains a gate it never had** — today a pre-existing identical enqueue
   row can already falsely match a brand-new record. Free bug fix.
5. **Delete the stamping block** (lines ~172-177). Every arm passes `since`.
6. Update the `matchPendingTurns` docblock and add a third rule to the file header's
   list: *eligibility is stateless — the matcher writes nothing to a record except a
   state transition, so `match(records, events)` cannot depend on how many passes
   preceded it.*

`sweepPendingTurns`, `toUnconfirmed`, `outcome`, `normalizeForMatch`, `isTerminal`,
`isTranscriptResolved` are unchanged. `sweep ∘ match` idempotence is preserved and
tightened — the stamping write was the one way `match` could report `changed: true`
without a transition.

**Ordering property worth keeping in the doc:** records are stored oldest-first and
`createdAt` is non-decreasing along the array, so thresholds are non-decreasing in the
same order the matcher walks records. With nested candidate windows and greedy
earliest-first assignment that is a maximum matching — no younger record can strand an
older one. The old scheme could violate this precisely because Retry re-stamped.

### Step 3 — `pending-turn/web/internal/reconcile.test.ts`

The fixtures currently mix a fake millisecond clock (`CTX.now = 10_000`,
`deadlineAt: 1`) with a real ISO timestamp (`at: "2026-07-22T00:00:00Z"`,
`Date.parse ≈ 1.79e12`). A mechanical rename would make the gate trivially true and
**silently invert** `"matches only events past the baseline"` instead of failing red.
Make the clock coherent first:

```ts
const SENT_AT = Date.parse("2026-07-22T00:00:00.000Z");
const AFTER   = "2026-07-22T00:00:05.000Z";  // the send's own row
const BEFORE  = "2026-07-21T23:50:00.000Z";  // a pre-existing identical row
```

`rec()` drops `baselineUserText` and uses `createdAt: SENT_AT`; `userText`/`enqueue`
take an optional instant defaulting to `AFTER`; `CTX.now` becomes `SENT_AT + 10_000` and
the matrix's `deadlineAt: 1` becomes `SENT_AT + 1` (still elapsed, same worst case).

- **Delete** `"stamps baseline on first pass so a pre-existing identical row never matches"` —
  it pins a mechanism that no longer exists.
- **Replace** `"matches only events past the baseline"` with
  `"matches only rows written at or after the send"`.
- **Add:** a row predating the send never matches; an *enqueue* row predating the send
  never matches; a pass that matches nothing returns the same array reference; a row
  inside the skew allowance matches and one outside it does not; two identical in-flight
  records bind distinct rows by their own send instants.
- **Add the incident as a test:** given one record and one final transcript, compare (a)
  a single pass over the full transcript against (b) N passes over growing prefixes
  `[] → [unrelated] → [unrelated, own row]`, and assert both end `sent`. Under
  `baselineUserText` (a) fails and (b) passes — **that asymmetry is the bug.**
- **Fixed-point matrix:** add a sixth transcript column,
  `["delivered before the send", [userText("hello world", BEFORE)]]` — 30 cases → 36.
  The plugin's rule is "a new transition means a new matrix row"; a new *eligibility*
  rule earns the same.

Expected to pass untouched: the `normalizeForMatch` suite, `"matches on resolvedText…"`,
the consumed-set tests, the enqueue-upgrade tests, all four failed-record tests, the
whole `sweepPendingTurns` block, and the parked-in-queue regression.

### Step 4 — close the seam (`web/__tests__/send-then-reconcile.test.ts`, jsdom)

This plugin's `CLAUDE.md` already confesses that the last crash "spanned the seam
between a pure, tested matcher and an impure, untested sweep, so it was unreachable by
any test". **The incident lives on the same seam** — `reconcile.test.ts` cannot express
"the first pass this record ever saw already contained its own row", because the pure
test chooses the passes. This is the part of the plan that prevents the next one.

Register a fake `TurnDelivery` (no network), unique conversation id per test,
`localStorage.clear()` in `beforeEach`. Four cases:

1. **The incident.** `sendConversationTurn`, flush microtasks to `posted`, then
   `reconcilePendingTurns` with the delivered row **as the record's very first pass**.
   The record is gone (matched, swept), no `turn-unconfirmed`. *This fails on `main`.*
2. **Retry keeps its watermark.** Drive to `unconfirmed`, `retryPendingTurn`, assert
   `createdAt` unchanged and that a transcript holding only the **original** delivery's
   row retires the record.
3. **A pre-existing identical row cannot resolve a fresh send** — record stays `posted`.

### Step 5 — prose

`pending-turn/CLAUDE.md`: replace the `baselineUserText` sentence (~line 76) with the
send-watermark rule (both `user-text` and enqueue rows); add a paragraph naming the
invariant and the incident; state in the state-machine paragraph that `createdAt` is
never moved, including across Retry, and why; extend "adding a transition means adding it
to the fixed-point matrix" with "and a new eligibility rule means a new transcript
column". The `AUTOGENERATED` block needs no hand-edit — `CLOCK_SKEW_ALLOWANCE_MS` stays
inside `internal/` and is not re-exported from the barrel.

## Verification

1. `./equin test plugins/conversations/plugins/conversation-view/plugins/pending-turn`
   — runs bun (`reconcile.test.ts`, the lint suites) **and** vitest (the new seam test).
   The 36-case matrix must be green, and the seam test must **fail on stashed `main` and
   pass after** — confirm that asymmetry explicitly or the test is decoration.
2. `./equin test plugins/conversations/plugins/transcript-watcher` for Step 0.
3. `./equin check` — the type-check finds every `baselineUserText` reader (three
   files, all in this plugin; nothing outside constructs a `PendingTurnRecord`).
4. `./equin build` (background, end the turn), then in the deployed app: send a
   turn and watch the echo card vanish as the row lands; send a turn whose text
   duplicates an earlier message in the same conversation and confirm it still resolves;
   exercise an AskUserQuestion answer and Push & Close, since both appear in the report
   set.
5. **The regression metric is already instrumented.** Baseline today: 18
   `turn-unconfirmed` report rows / 23 episodes / 18 conversations since Aug 16 —
   `select first_seen_at, data->>'conversationId', count from reports where kind='turn-unconfirmed' order by first_seen_at desc`.
   Re-run a few days after deploy; the rate should collapse, and any survivor is now a
   *genuine* dropped paste worth reading.
6. Pre-existing stranded records self-heal: a browser holding an `unconfirmed` record
   whose text is in the transcript loses its card on the first reconcile after the
   update, with no user action.

## Sequencing and risk

Steps 1 + 2 + 3 are one atomic edit (the type change and its readers). Steps 0 and 4 are
independent. No persistence migration, no server change, no wire-format change, no
barrel or export change — so no `plugin-boundaries` or registry impact.

The one thing to get right under review: **do not reintroduce a required field on
`PendingTurnRecord`.** `persist.ts` casts rather than validates, so a field added today
is `undefined` on every record already on disk, and a numeric comparison against
`undefined` is `false` — the exact silent non-match this change exists to delete.

## Out of scope

The Aug 18 11:05 send that never reached the CLI **at all** — no matching line in either
session file — is a separate defect, upstream of this one, in the tmux paste/submit
path. `pasteTurn` deliberately does not throw on submit-verification failure and defers
the verdict to this matcher, so a genuinely lost paste and a mis-matched delivery
currently look identical to the user. Worth its own investigation once the matcher stops
producing false negatives and the report stream is clean enough to read.
