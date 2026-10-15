# pending-turn

Owner of the **entire turn-send lifecycle**, and the **single entry point** for
sending a turn from the browser. A caller does one thing —
`sendConversationTurn(conversationId, { text })` — and nothing else; from there
this plugin creates a durable record (localStorage,
`singularity:pending-turns:<conversationId>`, persistence idiom mirrored from
`persistent-draft`), runs the delivery (30s abort), and verifies delivery
against the transcript — "sent" means *the text was found in the session JSONL*,
not "the request returned 200".

## One entry point, many deliveries

Surfaces that send a turn (prompt input, template chips, Send/Queue/Go, Push &
Close, AskUserQuestion answers) differ in exactly one respect — **which endpoint
carries the request** — so that part alone is a `TurnDelivery`
(`internal/delivery.ts`) and the rest is shared. Calling a turn endpoint
directly from web code is a lint error
(`turn-send-safety/no-adhoc-turn-send`, this plugin's `lint/`) outside the three
sanctioned delivery modules: a direct call looks identical on the happy path
while silently having no echo, no deadline, no report and no Retry.

A delivery is registered under a **stable id**, not passed as a closure, because
a record outlives the tab that made it: Retry re-dispatches after a reload. The
record stores `{ deliveryId, payload }` (both serializable); `deliveryFor()` is
the one place a legacy record with neither field is read as a plain
`postConversationTurn` send. **Contributor rule:** re-export your
`defineTurnDelivery` module from your plugin's web barrel — registration must
happen at plugin load, not at first mount of the sending component, or Retry
after a reload finds nothing (→ `failed-post`, `failureKind: "delivery"`).

`echo: false` suppresses the in-flight card for a surface with its own inline
pending state (the answer form, whose delivered turn the transcript also hides).
It deliberately does **not** suppress the failure card: a send needing Retry must
be reachable however it started.

State machine per record: `sending → posted|held → queued/sent`, with
`failed-post` (`http` | `network`) on a POST failure and `unconfirmed` when the
90s confirmation deadline elapses without a transcript match (the tmux
paste-race symptom — files one deduped `turn-unconfirmed` report on entry).
Never-revert: the transcript is ground truth; a late POST outcome can only
enrich a matched record. This holds **symmetrically** — a POST failure is not
final either. `failed-post`/`unconfirmed` records stay matchable, so a turn the
agent actually received (its *verification* failed, not its delivery: a tmux
submit-verify timeout, a 500 raised after the paste, a torn connection) retires
its own failure card on the next reconcile instead of stranding beside the
delivered message. Nothing but the transcript resolves a record. Failures are
**manual retry only** — the paste race can strand text in the CLI input box, so
re-send must be deliberate.

`held` is `posted` for a conversation that was still `starting`: the turn
endpoint answers `held: true` when the server kept the turn because the agent
cannot take input yet (the conversations server's `held-turns.ts` delivers it
as the launch message, or types it in once the input box first appears). It
shares everything with `posted` — the deadline, the sweep, the matcher, all
through `awaitsConfirmation` — and differs only in the card's caption
("Waiting for the agent to start…"). A held turn delivered as the launch
message lands in the transcript behind the task's preprompt block, so the
user-text arm also accepts a row that ENDS with the record's text at a word
boundary (`rowCarriesText`); the enqueue arm stays identity-only.

That same symmetry is why `createdAt` — the instant the send was dispatched,
and the record's only notion of time — is set once and never moved, including
across Retry. It carries two jobs at once: it is the TTL origin, and it is the
transcript watermark described below. Keeping it fixed across Retry is more
than simpler: it is the ground-truth rule above applied to the record's own
history. If the original send landed and only its verification failed, the
original send's own row is what should retire the record, so Retry must leave
that row inside the record's matching window; re-stamping it forward on Retry
could only hide a delivered turn behind a duplicate.

Never-revert is **enforced, not merely documented**: `toUnconfirmed` in
`internal/reconcile.ts` is the single transition into `unconfirmed`, and it
returns a transcript-resolved (`queued`/`sent`) record untouched. Every path
that could otherwise strand a record — the deadline timer, the owner-tab reload
adoption, the TTL sweep, the FIFO overflow — routes through it. Consequently
`deadlineAt != null` means exactly "awaiting first transcript confirmation": it
lives only on `posted` / `held` records, is cleared the moment the transcript accounts
for the record, and is never inherited across a match. Before that, a record
promoted `unconfirmed → queued` off an enqueue row kept its already-elapsed
deadline and was demoted straight back, and the two rules cycled forever — one
commit + `notify` per lap, inside the pane's render effect, until React threw
*Maximum update depth exceeded*.

## The transition is pure; the store is only side effects

`internal/reconcile.ts` holds the **whole** record→record transition as two pure
passes — `matchPendingTurns` (transcript identity match) then
`sweepPendingTurns` (reload adoption, deadline, TTL) — with no storage, timers,
clock, or reporting. `store.ts` composes them and owns every effect. The split
is not tidiness: the cycle above spanned the seam between a pure, tested matcher
and an impure, untested sweep, so it was unreachable by any test.

Matching: normalized-text identity (image `@<path>` tokens stripped mirroring
the transcript parser, whitespace collapsed) against the server's
`resolvedText`, gated by the **send watermark**: a record binds only rows the
session log wrote at or after the instant its own send was dispatched
(`createdAt`, minus a 1s clock-skew allowance). The gate applies to both the
user-text arm and the queue-op enqueue arm — the enqueue arm previously had no
gate at all — plus a per-pass consumed-index set (two identical in-flight
messages bind distinct events; user-text → `sent` outranks queue-op enqueue →
`queued`). The `jsonl-viewer` pane owns the events array and drives
`reconcilePendingTurns` on every change; deadlines are absolute one-shot
`setTimeout`s (owner tab arms them; any tab's reconcile can adopt an orphaned
record). The TTL sweep (7d) never drops a non-terminal record silently — it
routes through `unconfirmed` (report) first.

The rule the watermark replaced stamped a baseline on the record's *first*
pass — one past the highest row present at that instant — so only a row from
that turn's own send could ever match, but only as long as the first pass ran
before that row landed. When a hidden tab, a throttled render, or a batched
commit deferred the first pass past the turn's own arrival, the row it
stamped past **was the delivery**: the record went `unconfirmed` while the
agent was already answering, the card told the user the message may not have
arrived, and Retry delivered the same text a second time. The invariant the
watermark restores: **the candidate rule is a property of the record and the
row, never of when the pane happened to reconcile** — `(record, transcript)`
must answer the same way no matter how many passes ran before it.

**`sweep ∘ match` must be a fixed point**, and `reconcile.test.ts` asserts it
across every state × transcript pair. The pane calls the pipeline from a render
effect and the store notifies its `useSyncExternalStore` subscribers whenever a
pass reports `changed`, so a transition pair that can undo each other is an
unbounded *synchronous* update loop, not a cosmetic flip-flop. Two rules keep it
convergent, both enforced in `reconcile.ts` rather than left to call sites: the
never-revert chokepoint above, and `changed` **derived from record identity**
(via `outcome()`) instead of hand-set — a pass cannot claim a change it did not
make, so a commit is never a no-op. Adding a transition here means adding it
to the fixed-point matrix, and adding an eligibility rule means adding a
transcript column — the matrix went from 30 to 36 cases the day the send
watermark arrived, the new column being a row delivered *before* the send. With
the stamping write gone, the matcher writes nothing but state transitions, so
a pass that matches nothing is now genuinely inert; it used to force a commit
+ notify on every fresh record's first pass purely to record its baseline.

`PendingTurnCard` renders by state (replace, never duplicate): dimmed echo card
for `sending`/`posted`/`held`, destructive/warning card with Retry + Copy-to-draft for
`failed-post`/`unconfirmed`, and nothing for `queued`/`sent` — the native
queue-op row / real user-text row has taken over. `sent` is transient (dropped
at reconcile, never persisted): a reconciled message gets no extra indicator,
and all feedback lives inside the message card itself.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The single entry point for sending a turn from the browser, and owner of the entire send lifecycle: a durable (localStorage) per-conversation pending-turn state machine (sending → posted|held → queued/sent, failed-post, unconfirmed) that runs the turn's registered TurnDelivery, verifies delivery against the transcript (normalized-text match), reports a conversation as working from the instant a turn is sent (useOptimisticConversationStatus), files a report when an accepted turn never lands, and renders the per-record PendingTurnCard. Every surface (prompt input, template chips, Send/Queue/Go, Push & Close, AskUserQuestion answers) calls sendConversationTurn and differs only in its delivery; the jsonl-viewer drives reconcilePendingTurns on every events change. Contributes the turn-send-safety lint rule. No slot contributions.
- Web:
  - Uses:
    - `conversations/conversation-view/user-message.UserMessageCard`
    - `conversations/conversation-view/user-message.UserMessageText`
    - `infra/endpoints.EndpointError`
    - `infra/endpoints.fetchEndpoint`
    - `infra/endpoints.getEndpointErrorMessage`
    - `primitives/css/bouncing-dots.BouncingDots`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.Button`
    - `primitives/css/ui-kit.cn`
    - `primitives/scope/tab-id.getTabId`
    - `primitives/sync-status.useReportSync`
    - `reports.report`
  - Exports (types):
    - `PendingTurnState`
    - `TurnDelivery`
    - `TurnDeliveryResult`
    - `TurnSend`
  - Exports (values):
    - `defineTurnDelivery`
    - `dismissPendingTurn`
    - `PendingTurnCard`
    - `reconcilePendingTurns`
    - `sendConversationTurn`
    - `useOptimisticConversationStatus`
    - `usePendingTurns`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shadow --shadow`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `conversations/all-conversations`
    - `conversations/conversation-view/jsonl-viewer`
    - `conversations/conversation-view/jsonl-viewer/tool-call/ask-user-question`
    - `conversations/conversation-view/prompt-input`
    - `conversations/conversation-view/prompt-templates`
    - `conversations/conversation-view/push-and-exit`
    - `conversations/conversation-view/status`
    - `conversations/conversations-view/data-view`
    - `tasks/outcome-report`
- Exemptions:
  - Exempts itself from: `turn-send-safety/no-adhoc-turn-send` — `web/internal/delivery.ts` (sanctioned)
  - Exempted by:
    - `conversations/conversation-view/jsonl-viewer/tool-call/ask-user-question` (0 debt)
    - `conversations/conversation-view/pending-turn` (0 debt)
    - `conversations/conversation-view/push-and-exit` (0 debt)

<!-- AUTOGENERATED:END -->
