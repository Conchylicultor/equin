# The block-content session: one owner, a proven hydration, and a projection that cannot lie

## Context

A block's rendered text can silently diverge from its content doc. The editor
renders empty while the `Y.Doc` and the server still hold the text (a reload
restores it), and the ~1 s `data.text` projection then writes that emptiness over
the row. Reproduced with two clients on one page (~1 in 50 splits under CPU
throttling); `1389bc872` added a guard that **detects** the state and heals it.

Detection after the fact is the wrong shape. The property that matters — *what
the user sees equals what the doc holds equals what the server holds* — is
nowhere stated, nowhere checked, and not representable. It is emergent over three
independent state machines on one object graph:

- `LiveStateYjsProvider` (13+ mutable fields, three of them added by the heal
  itself), `web/internal/live-state-yjs-provider.ts`;
- `BindingReplica` + a refcounted `CanonicalConnection`,
  `web/internal/binding-replica.ts`;
- the module-level `CollabDocEntry` registry (refs, deferred destroy,
  `suppressUndoCapture`), `web/internal/use-collab-block-doc.ts`.

Three deferred-destroy timers, layered under React mount ordering and
`@lexical/yjs`'s binding lifecycle — which offers **no read-the-doc operation at
all** (hydration is post-attach `observeDeep` events only).

Two consequences are their own defects, and this plan targets those first:

- **The recovery surface is write-only.** Every anticipated failure is "bytes did
  not reach the server" (`retryFlush`, the 409 re-init, teardown retention, the
  offline requeue, the sync cloud). `rehydrateFromServer()` is the sole read-side
  counterpart and it exists only because a consumer noticed. Concretely:
  `ingestServerState()` (`live-state-yjs-provider.ts:486`) issues the `doc-init`
  **pull only when the subscribed state is `null`**. For a block whose doc row
  already exists, hydration is the live-state subscription value and nothing
  else — no request, no timeout, no bound.
- **A derived value can overwrite what it disagrees with.** The projection
  serializes the **editor** (`serializeBlockRuns(editor)`,
  `collab-text-plugin.tsx:66`) and persists it — an absorbable failure, since
  empty runs are indistinguishable from a legitimately empty block.

**Intended outcome:** the projection becomes a pure function of the owner (so it
*cannot* write a value it did not read from the doc, enforced by the type
system); hydration becomes a request/response the seam owns and **proves**; and
the three lifecycles collapse into one session object with an explicit
`attaching / hydrating / hydrated / stalled` state.

### One premise corrected before designing on it

> "page-block-doc has 375 recorded live-state missed-updates wedge reports"

The data does not support the attribution. `reports` holds **one** row,
`kind='crash'`, `data.errorType='LiveStateWedge:missed-updates'`, `count=377`,
first seen 2026-06-12. It is fingerprinted on the discriminator **alone**
(`crash-collector.tsx`), stores no resource name, and the sampled message names
`tasks`. So: 377 confirmed live-state gap events across *all* resources over
~7 weeks, none attributable to `page-block-doc`.

This strengthens rather than weakens the design. The gaps are real, the probe
that finds them only runs on `hidden → visible`
(`wedge-watchdog.tsx`), and `page-block-doc` rides the same path — so push
delivery must not be the only hydration path regardless. **Making the wedge
report name its resource is a separate one-file change in
`plugins/infra/plugins/health` + `plugins/reports/plugins/crash`; file it as its
own task rather than folding it in here.** Nothing below depends on the answer.

---

## The design

### R1 — A projection may never write a value it cannot prove equals its source

Project from the **doc**, not the editor:

```ts
// collab-text-plugin.tsx:66 — today
const runs = serializeBlockRuns(editor);
// becomes (in the seam, see R3):
const runs = xmlTextToRuns(yDocContent(entry.doc), {
  extensions: getBlockTextExtensions(),
  nodes: blockTextNodes(),
});
```

This is not a re-implementation: `xmlTextToRuns` (`core/runs-yjs.ts:100`) *is*
`readYDoc(doc, e => serializeBlockRuns(e, extensions), …)` — the same walk, the
same function object. The node sets match exactly (`block-text-editor.tsx:258`
`[LinkNode, ...blockTextNodes()]` vs `runs-yjs.ts:114`), decorator fidelity comes
from the same `extensions` array via `tokenOf`, and neither side runs node
transforms during ingest (`syncYjsChangesToLexical` passes `skipTransforms`).
The seed builder already passes exactly these options
(`use-collab-block-doc.ts:219-223`).

**Do not replace `readYDoc` with a raw `toDelta()` → runs walk.** Counting is
cheap (`xmlTextContentLength` gets away with it); *producing runs* raw would mean
re-deriving marks/color from `CollabTextNode`'s property sync, link nesting from
an embedded `XmlText`, and decorator tokens from a node instance that must exist
to be handed to `ext.serializeNode(node)`. That is the fork `runs-yjs.ts:19-25`
and `headless-collab.ts:96-99` explicitly forbid, and a drift there is silent
data loss on persist.

**Cost — measured, stage 1.** Per flush, `xmlTextToRuns` is 20–900× the cost of
`serializeBlockRuns` (in-browser on deployed artifacts: 19.5 ms vs 0.106 ms under
host load 26; in bun: 1.19 ms vs 0.0013 ms — absolute values are dominated by
host noise, the ratio is not). But the flush *count and shape* are unchanged: a
200-block cold open is 201 flushes spread over 456 ms as separate macrotasks,
none near the 50 ms long-task threshold. Net ≈50–250 ms of spread-out CPU on
page open; steady-state typing ≈0.2–1 ms/s per edited block. Not a material
regression — no mitigation applied.

> Both planned mitigations were examined and **rejected with reasons**. The
> length pre-gate is *vacuous*: Yjs only emits `doc.on("update")` when a
> transaction actually integrated content, so "did the doc change since the last
> flush" is already true whenever the timer is armed — and the one case it would
> catch (page open, doc changed but row already matches) needs the row measured
> in the Yjs basis, i.e. a **third** implementation of that walk, which is the
> fork R1 forbids. Pooling buys ~11 % (`createEditor()` is 0.13 ms of a 1.19 ms
> call; the binding is bound to a per-call empty replica `Doc`, which *is*
> `readYDoc`'s hydration contract) for a state-reset hazard.

**Three `serializeBlockRuns` callers, one discriminator.** Split
(`keyboard-plugin.tsx:82`), merge (`:109`) and `readRuns`
(`block-text-editor.tsx:331`) want *what the user is looking at right now,
including uncommitted keystrokes* — they stay editor-sourced and are correct.
The projection wants *what the block is*. State that rule in `editor/CLAUDE.md`.

**Enforcement is a type, not a lint rule** — an ESLint rule cannot see
provenance. `DocSourcedRuns` (landed, `web/internal/doc-sourced-runs.ts`) brands
the persistence-bound value, is produced **only** by `projectableRunsOf(doc)`
around `xmlTextToRuns`, and is required by `projectText`. "The projection wrote a
value it did not read from the doc" is now a **tsc error** — the same enforcement
class as `PageForestTx` (`no-adhoc-forest-write`) and `RowData`'s
`{ text?: never }`.

> Implemented with a module-private `declare const … unique symbol` **key**
> (mirroring `PageForestTx`) rather than the `{ __docSourced: unique symbol }`
> field sketched above: a private symbol key makes the type structurally
> *unnameable* outside its module, not merely un-inhabitable. It lives in
> `web/internal/`, not `core/` — the sole producer needs the web-only extension
> registry, and a `core/` home would invite a second producer without one.

### R2 — Hydration is a proven request/response, not a delivered push

One authoritative pull per session, and it is `doc-init` — which is already
idempotent first-writer-wins (`INSERT … ON CONFLICT DO NOTHING` then `SELECT`,
`doc-store.ts:44-70`) **and** returns the authoritative state, so it is
simultaneously the re-read and the re-assert, and it is the only verb that
arbitrates 404/409. Do **not** add a `GET doc-state`: a second read path with
none of that arbitration.

Three corrections make "unconditional" actually workable:

- **It cannot be unconditional on attach as literally stated.** `maybeInit()`
  returns immediately when `!blockRowConfirmed`
  (`live-state-yjs-provider.ts:640`), so a freshly-split block would sit
  un-hydrated for a full server round trip — destroying the instant-split path.
  The session needs an explicit **locally-authoritative arm**: `!rowConfirmed` ⇒
  apply the deterministic seed (which `connect()` already does, `:311-313`),
  verify against it, `hydrated`, no network. The later
  `markBlockRowConfirmed`-triggered doc-init is a re-assert that must not
  re-open the gate, reset the replica, or change the state.
- **Make it cheap enough to be unconditional.** `initBlockDoc` returns the whole
  compacted state; on a 200-block page open that duplicates every block's bytes
  over the wire on top of the sub-ack that already delivered them. Send the
  client's `encodeStateVector(doc)` and return `Y.diffUpdate(authoritative,
  clientVector)`. Happy path (including a pre-seeded new block whose
  deterministic bytes already match) is a near-empty response. `lastAppliedState`
  (`:204`) must then key on something other than full-state base64 — a diff is
  not a state.
- **Post the state vector, never a `data.text` seed, for a doc that already has
  content.** `initDoc` picks `encodeStateAsUpdate(this.doc)` only when
  `recovering && store.clients.size > 0` (`:681-696`); otherwise it posts a
  `data.text`-derived seed. The server discards it today, so this is harmless
  *now* — but firing on every attach means routinely posting a seed derived from
  a row that lags its own doc, and any future change to the conflict handling
  turns every page open into a duplication event. Same rule the provider already
  states at `:180-183`.

What this buys: a session cannot reach `hydrated` without the server's answer, so
"the doc is behind the server" stops being a state the app can sit in silently.
The `STARVATION_SETTLE_MS = 5000` timer — the only timer in the hydration story,
and one that exists solely because the current design cannot tell "not arrived
yet" from "never arriving" — is deleted.

*(Narrower framing worth recording: a **first** subscribe already is an
authoritative pull — the WS sub-ack. What has no pull is a **resurrected**
subscription inside the 30 s keep-alive over a stale RQ cache
(`notifications-client.ts:641-651`), and a genuinely missed push.)*

### R3 — One session object, one lifetime, an explicit state

```ts
type SessionState =
  | { kind: "attaching" }                 // replica minted EMPTY, binding mounting
  | { kind: "hydrating" }                 // authoritative state requested / applying
  | { kind: "hydrated"; at: number }
  | { kind: "stalled"; reason: StallReason; shownLength: number; docLength: number };
```

One `CollabSession` per (block, binding). It owns the replica's lifetime, the
pull, the verification, and the projection flush. `rehydrate()` disappears as a
verb: recovery is *end this session, start a new one*, which by construction
mints a fresh empty replica and pulls — so recovery and normal attach are one
code path, and the three-way `rehydrateFromServer` + `resetReplica` +
`setAttachGeneration` coordination goes away.

**The canonical registry entry stays** — it is the block's owner, and four
consumers need the union across replicas: the per-block `Y.UndoManager` and its
dynamic tracked-origin learning (`use-collab-block-doc.ts:280-297`),
`captureBlockDocEdit` (`:345-367`), the projection observer (`:662-668`), and one
transport/queue/save-state per block. (The offscreen surgery
`appendRunsToBlockDoc`/`truncateBlockDocFrom` bypasses the registry entirely, so
it is *not* what makes the entry load-bearing.) What R3 removes is the **id-keyed
reach into it**: `captureBlockDocEdit(entry, …, { suppressUndoCapture })` instead
of `registry.get(blockId)` plus entry-level mutable state.

**Verifying `hydrated` — the proposal's obvious form is wrong twice.**

1. *Not the same basis.* `xmlTextContentLength` (`core/runs-yjs.ts`) counts over
   the Yjs shape; `runsLength(serializeBlockRuns(…))` counts a decorator as
   `tokenOf(node).length` (e.g. `[[9f3c…]]`) and pushes **+1 per paragraph join**
   (`runs-lexical.ts:283`). Any block with an inline page-link, date chip or
   inline math — or any multi-paragraph block — fails the equality while
   perfectly hydrated. The current guard survives only because it compares
   against **zero**.
   → `$xmlBasisContentLength()` (landed, `block-text-extensions.ts:222-290`) is
   the editor-side twin, pinned to `xmlTextContentLength` by a property test over
   the shared fuzz corpus (`core/runs-corpus.ts`).

   > **Corrected during Stage 0 — the obvious mirror is wrong.** `@lexical/yjs`
   > represents a `CollabTextNode` as **two** delta ops (an embedded `Y.Map` of the
   > node's properties, then the string), so the Yjs walk counts `"hello"` as **6,
   > not 5** — the editor side must add **+1 per `TextNode`**. A `LineBreakNode` is
   > likewise an embedded `Y.Map`, not an `XmlElement` (both still count 1, so that
   > part was harmless). `xmlTextContentLength`'s own doc-comment was wrong and has
   > been corrected.
   >
   > **Consequence for R5:** the number is an *agreement witness*, not a character
   > count. If `stalled` reports are to show human-readable lengths, **both** halves
   > must be re-based in lockstep (skipping the property `Y.Map`s) — never one.
2. *Not synchronous.* `syncYjsChangesToLexical` calls `editor.update(…)` with **no
   `discrete`** (`@lexical/yjs@0.44.0`), and `$commitPendingUpdates` is
   micro-tasked (`lexical@0.44.0`), while yjs emits `doc.on('update')` at the tail
   of the same `applyUpdate`. So in any of our own handlers the editor is exactly
   one microtask stale — a same-turn check would report a blind binding on
   **every keystroke**.
   → Verify on the first `editor.registerUpdateListener` commit carrying
   `COLLABORATION_TAG` after the catch-up apply: the direct causal successor,
   bounded, not a timer. Two traps: an apply producing no Lexical dirt schedules
   **no commit at all**, so a catch-up carrying zero content must count as
   trivially hydrated; and `$ensureEditorNotEmpty` fires an *untagged* follow-up
   commit that must not be mistaken for the collab one. Do **not** reach for
   `editor.read()` to force synchrony — from a Yjs update handler it re-enters
   `syncLexicalUpdateToYjs` inside that doc's own transaction cleanup.

**Measure the replica, not the canonical.** `docContentLength()` reads the
canonical today (`use-collab-block-doc.ts:746`); the session's honest question is
"did *my* binding ingest what *my* replica holds".

### R4 — Gate the write path, not the editing host

The intuitive form of "a non-hydrated session is not an editing host"
(`contentEditable=false`) **deadlocks the caret authority**, and produces a
strictly worse failure than the one it prevents. Chain: a non-focusable root
makes `focusHydratingAware`'s `root.focus()` a silent no-op; that function calls
`unregister()` **before** its `activeElement` check
(`collab-text-surgery.ts:239-240`), so `onLanded` never fires and the listener is
gone; `reconcile()` only counts commits where the target is **not rendered**
(`caret-authority.ts:557-565`), and the target *is* rendered, so `FLIGHT_MISS_LIMIT`
never trips. The flight becomes permanent, the keyboard is held, no abort and no
report — the user types into nothing.

So: **`hydrating` means the projection does not write and the transport does not
flush.** The block stays a normal editing host; keystrokes land in the doc, which
is the CRDT-correct outcome — the replica is empty *by construction* at attach,
so an edit into a not-yet-hydrated replica is a legitimate concurrent edit that
merges, never a wrong baseline. (The "typing into a blind binding rebaselines"
worry was overstated; the genuinely dangerous thing was always the derived write,
which is R1's job.) Reaching `hydrated` is what unlocks the projection.

**Placeholder, using a witness we already render.**
`runsLength(runsOf(block.data.text))` (already read for `isEmpty`,
`block-text-editor.tsx:230-231`) says whether the block *should* have text. Row
non-empty + not `hydrated` ⇒ a skeleton at roughly the row's length. Row empty ⇒
the ordinary empty line, no affordance — never a spinner on an empty paragraph,
which would put a loading indicator on most of a fresh page. `stalled` ⇒ a
visible retry.

**`persist={false}` and read-only need nothing.** `LocalYjsProvider.connect()`
seeds synchronously and the relay attaches before `connection.acquire()`
(`binding-replica.ts:268-280`), so the local arm goes `attaching → hydrated`
inside one synchronous `connect()` and never leaves it — share the machine, don't
fork it. `read-only-view` mounts no Lexical, so it has no binding to be blind;
it is instead the strongest argument *for* R1, since it renders the projection —
a persisted blindness shows up there, in history diffs, and in search.

### R5 — What the report kind becomes

`blind-binding` and `starved-doc` become unreachable: the projection can no
longer read the editor at all (R1), and a session cannot reach `hydrated` without
the server's answer (R2). The honest remainder is **`stalled`** — the pull failed,
or the binding did not ingest what its replica holds — which is genuine,
actionable, and exactly what deserves a Retry.

> **Already shifted in stage 1.** The guard could no longer sit *in front of the
> write*: the doc-sourced value is always correct, so gating the write on it
> would suppress a legitimate one. It is now a pure **detector** with identical
> trigger semantics (`shown === 0 && doc > 0` → report + `rehydrate()`), driven
> by the seam's `subscribeDocUpdates` rather than the deleted `HydrationOpsRef`.
> The "guard sits in FRONT of the projection write" prose in `editor/CLAUDE.md`
> was updated accordingly. This is the intended trajectory — R1 makes the guard's
> *protective* half redundant, and stages 3–4 make its *detective* half
> structural — but note that the render defect is untouched by stage 1.

Two fixes while in there: `shownLength` is documented as one of "three
independent witnesses" (`collab-hydration-kind.ts:22-28`) but **both** call sites
hardcode `0` (`collab-text-plugin.tsx:187`, `:208`) — under R3 the session has a
real same-basis rendered length at the moment it decides `stalled`. And the
fingerprint is `sha256("collab-hydration|" + reason)`, so renaming the reasons
orphans the existing rows — fine, but be deliberate.

---

## Staged migration

Each stage builds, deploys, and leaves the app working.

| # | Stage | Risk |
|---|---|---|
| **0** ✅ | `$xmlBasisContentLength()` + property test over a shared fuzz corpus (`core/runs-corpus.ts`); `focusHydratingAware` landing-loss abort. | none — and it caught the basis error above, exactly as intended |
| **1** ✅ | **R1**: doc-sourced projection, moved into the seam; `HydrationOpsRef` deleted; teardown flush owned by the hold. | landed; cost measured — see below |
| **2** ✅ | The `DocSourcedRuns` brand, so stage 1 cannot regress. | none |
| **3** ✅ | **R3 (object only)**: `CollabSession` owns the replica lifetime and *one* retention timer; `captureBlockDocEdit(entry, …)`; `rehydrate()` → new session. No state machine yet. | landed — see below |
| **4** ✅ | **R3 (state) + R4**: the four states; verify on the first `COLLABORATION_TAG` commit; gate **projection + flush** on `hydrated`; the `locallyAuthoritative` arm for `!rowConfirmed`; the row-length-driven placeholder. | landed — see below |
| **5** | **R2**: diff-shaped `doc-init` (client sends `encodeStateVector`, server returns `Y.diffUpdate`); one pull per session; `lastAppliedState` reworked. | high (server + wire) — do last: stages 1–4 already remove the *persisted* defect, so this buys the timer deletion, not the safety |
| **6** | **R5**: retire `blind-binding`/`starved-doc`, introduce `stalled`, feed `shownLength` truthfully, delete `STARVATION_SETTLE_MS`. | low — and check Reports first: if `starved-doc` still fires after stage 5, stage 5 is wrong |

> **Stage 3 landed.** New module `web/internal/collab-session.ts`:
> `BlockDocOwner` (the per-block canonical doc/provider/`UndoManager`, with its
> refcount and undo-capture suppression made `private`) + `CollabSession` (one
> per block+binding). The three deferred destroys are ONE `session.end()`,
> deferred a macrotask (StrictMode / remount-in-place, cancelled by
> `session.retain()`) and then push-based onto the binding's own `disconnect()`
> whenever the replica is still connected (`BindingReplica.isConnected` /
> `setDisconnectListener` — new). Release is by owner REFERENCE, so latent
> breakage 2 and 3 are closed by construction; the "replica tagged with a
> different entry" reconciliation is retired for the same reason. `rehydrate()`
> is `session.restart()` (new session ⇒ fresh empty replica + authoritative
> re-read) plus the `attachGeneration` key bump — the ref-once
> `providerFactory` / `createBinding` claim re-verified in the installed
> `@lexical/react` 0.44. `captureBlockDocEdit(owner, edit)` takes the owner;
> `blockDocOwnerOf(id)` is the one id-keyed read left. No behaviour change, no
> state machine.

> **Stage 4 landed.** `SessionState` + the two arms live on `CollabSession`;
> `BindingReplica` announces the end of every `connect()` (`onConnected`) so the
> session can read its own replica and decide what its binding has to prove;
> `BlockDocProvider` grew `isSynced` + a refcounted
> `acquireFlushHold`/`releaseFlushHold`; the seam gates `flushProjection` on
> `session.writeAllowed` and re-runs a dropped window push-based off the state
> subscription; `useHydrationVerification` (`collab-text-plugin`) reports
> `$xmlBasisContentLength()` on the first `COLLABORATION_TAG` commit;
> `HydrationPlaceholder` renders the skeleton / Retry.
>
> Four deviations from the sketch above, each with a reason:
>
> - **The locally-authoritative arm does not verify at all** — it is `hydrated`
>   inside `connect()`, synchronously. Verification exists to prove "the
>   authoritative answer reached my binding"; when this client IS the authority
>   there is no such answer, and the arm's whole point is that a client-minted
>   block never waits. Consequence (deliberate): `stalled` becomes structurally
>   unreachable in memory mode, exactly as R4 requires, without forking the
>   machine.
> - **`stalled` OPENS the gate** rather than keeping it closed. A failure that
>   also holds the user's unflushed bytes is strictly worse than the defect;
>   `stalled` is a visible Retry, not a quarantine. `end()` opens it too, so an
>   unmount always flushes.
> - **"An empty catch-up is trivially hydrated" is decided on the transport's
>   `sync`, not on the replica alone.** Verified in the installed packages: an
>   apply that integrates nothing emits no Yjs update at all, so no commit is
>   ever scheduled — but "the replica is empty right now" is also the normal
>   state of a block whose push has not arrived. `synced && nothing renderable`
>   is the honest predicate, and it is push-based (the provider's own `sync`
>   announcement), not a timer.
> - **`restart()`'s successor is server-authoritative** whenever there is a
>   server: a recovery re-reads the server, so it must not inherit the
>   locally-authoritative arm the original session may have started on.
>
> The `promoteOnly` probe is what makes the listener's registration order
> harmless: `CollaborationPlugin` is a CHILD, so its `connect()` has already run
> when `useHydrationVerification`'s effect registers.

## Latent breakage to fix on the way through

These produce no error and no test failure today.

1. ~~**`focusHydratingAware` unregisters before it checks `activeElement`**~~
   **DONE (stage 0).** Resolved as a named abort rather than by reordering:
   `CaretLandOptions.onLandingLost` (the failure dual of `onLanded`) →
   `"landing-focus-lost"`. Reordering was rejected because the existing
   justification for the silent bail — "the authority's own focus-left abort owns
   that case" — is unsound twice over: `onFocusOutCapture`
   (`caret-authority.ts:335-344`) returns early when `relatedTarget === null`, so
   a steal landing on `<body>` is invisible to it, as is a steal onto another
   block inside the container. Reordering would have converted "landing lost"
   into "landing pending forever" — an unbounded silent wait.
2. **`releaseCollabDoc` releases by block id, not entry identity**
   (`use-collab-block-doc.ts:393-403`; same in `ensure()`'s re-key path,
   `:567-568`). If an entry is ever replaced between a hold's acquire and its
   release, the release decrements the wrong entry — leaking the dead one and
   prematurely destroying the live one. `finalizeEntry`'s `refs > 0` bail
   (`:382`) is what keeps this from firing. The session must hold the **entry
   reference**, not the id. **DONE (stage 3)** — `CollabSession` holds the
   `BlockDocOwner` reference; there is no id-keyed release left.
3. **`entry.destroyTimer` is a single slot** (`:399`) against three independent
   deferred destroys — the entry's, the hold's (`:613-619`), and `resetReplica`'s
   (`:636`) — so a `rehydrate()` racing an unmount can destroy a replica whose
   binding is still mounted, relaying its last edits nowhere. **Stage 3 collapses
   these to one session-owned lifetime.**
4. ~~**The projection's unmount flush relies on React hook declaration order**~~
   **DONE (stage 1).** The projection now lives *inside* `useCollabDocHold`,
   whose single unmount cleanup does `flushProjection()` then
   `releaseCollabDoc()`. That is why it went into the hold rather than staying a
   sibling hook: any sibling arrangement re-inherits the ordering from React's
   hook-declaration order, which is the hazard itself.

## Critical files

- `plugins/page/plugins/editor/web/internal/use-collab-block-doc.ts` — the seam;
  session object, registry, lifetimes
- `plugins/page/plugins/editor/web/components/collab-text-plugin.tsx` — projection
  moves out; guard retires
- `plugins/page/plugins/editor/web/internal/live-state-yjs-provider.ts` — pull,
  `lastAppliedState`, the FK gate
- `plugins/page/plugins/editor/web/internal/binding-replica.ts` — replica becomes
  session-private
- `plugins/page/plugins/editor/web/internal/block-text-extensions.ts` —
  `$xmlBasisContentLength`
- `plugins/page/plugins/editor/web/internal/collab-text-surgery.ts` —
  `focusHydratingAware` ordering
- `plugins/page/plugins/editor/core/runs-yjs.ts` — `xmlTextToRuns`, the basis walk
- `plugins/page/plugins/editor-collab/server/internal/doc-store.ts` +
  `core/internal/endpoints.ts` — diff-shaped `doc-init` (stage 5)
- `plugins/reports/plugins/collab-hydration/` — report kind (stage 6)
- Reused, do not rebuild: `readYDoc` / `yDocContent`
  (`primitives/collab-doc/core`), `patchesFromDiff` / `diffBlocks`
  (`core/block-diff.ts`), `getBlockTextExtensions` / `blockTextNodes`.

## Verification

`./equin build` first, then per stage:

- **Stage 0** — `bun test plugins/page/plugins/editor/core/runs-yjs.test.ts`; the
  new property test must show the two length walks agree over the fuzz corpus for
  every registered extension set. Add a `page-editor:projection-basis-agrees`
  check (`editor/check/index.ts` already does `importBarrel`) asserting
  `xmlTextToRuns(runsToXmlText(r)) === coalesce(r)` — this is the drift a lint
  rule can only gesture at.
- **Stage 1** — `bun plugins/page/plugins/editor/e2e/crdt-typing-verify.ts` and
  `crdt-reopen-verify.ts`. Measure the page-open flush burst on a 200-block page
  before and after (instrument the flush; read it off the runtime profiler).
- **Stage 3** — `bun run test:dom plugins/page/plugins/editor` for
  `collab-doc-registry.test.ts` + `binding-replica.test.ts`, extended with
  "release then re-acquire mints a different entry, and the stale hold's release
  does not decrement it".
- **Stage 4** — `bun plugins/page/plugins/editor/e2e/split-typing-verify.ts` and
  `web/__tests__/caret-authority.test.tsx` **before** anything can gate a block;
  then the two repro drivers from `1389bc872` —
  `e2e/split-empty-repro.ts --rounds 40 --cpu 4` and
  `split-empty-repro-2clients.ts --rounds 15 --cpu 4` — must run clean where they
  previously reproduced ~1 in 50.
- **Stage 5** — `bun test plugins/page/plugins/editor-collab/server/internal/doc-store.test.ts`
  (real DB), extended for the diff response and for "diff against an empty vector
  equals the full state". Plus `crdt-multitab-agent-verify.ts` and
  `crdt-offline-verify.ts`.
- **Stage 6** — `query_db` on `reports` for the `collab-hydration` kind: the two
  old reasons must be absent after stage 5, and any `stalled` row is a real
  defect to chase, not a heal.
