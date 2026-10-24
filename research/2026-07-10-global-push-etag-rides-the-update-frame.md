# The push-path ETag rides the `update` frame — and nothing else

Date: 2026-07-10
Category: global (framework/resource-runtime)

Follow-up to `research/2026-07-09-global-etag-value-coproduction.md` (the third bullet
under **Follow-ups**).

## Context

`drainEntry` and `drainMembershipFull` each hoist one line above their frame-kind branch:

```ts
const updateEtag = entry.revalidate ? await pushEtag(entry, params) : undefined;
```

Only the `kind: "update"` frames ever spread it. The `kind: "invalidate"` frame and every
`kind: "delta"` frame discard it. The signature is computed, hashed, and thrown away.

| Site | Enclosing fn | Frame | Uses the etag? |
| --- | --- | --- | --- |
| `runtime.ts:1899` | `drainMembershipFull` | `update` | yes |
| `runtime.ts:1910` | `drainMembershipFull` | `delta` | **discarded** |
| `runtime.ts:2049` | `drainMembershipScoped` | `delta` | never computes it — already right |
| `runtime.ts:2218` | `drainEntry` | `invalidate` | **discarded** |
| `runtime.ts:2239` | `drainEntry` (keyed, scoped, no snapshot) | `update` | yes |
| `runtime.ts:2255` | `drainEntry` (keyed scoped) | `delta` | **discarded** |
| `runtime.ts:2277` | `drainEntry` (keyed FULL, no snapshot) | `update` | yes |
| `runtime.ts:2288` | `drainEntry` (keyed FULL, has snapshot) | `delta` | **discarded** |
| `runtime.ts:2305` | `drainEntry` (push mode) | `update` | yes |

Four resources declare `revalidate` today: `edited-files` (`invalidate`), `jsonl-events`
(`push`), and commits-graph's `delta` + `graph` (both `push`). No keyed resource declares one.
So the **live** waste is exactly `edited-files`, and it is the whole of its push path:

- `getConversation(id)` — a DB read
- `git rev-parse HEAD`, `git merge-base main HEAD`, `git status --porcelain -z`
- one `lstat` per dirty file

That runs on every watcher-observed change to the edited-file list, for every subscribed
conversation, to produce a value the very next line drops. `pushEtag` is deliberately
**ungated** (it sits outside the read-admission semaphore, since the flush cascade is bounded
by the DB gate instead), so none of this shows up against the read budget.

The keyed-`delta` discards are latent, not live — but they are the same bug and the fix closes
them for free.

### The invariant

The client already states it. `notifications-client.ts`'s `ServerMsg` union declares `etag?`
only on `sub-ack` and `update`, and `handleServerMessage` stores an etag only from those two
kinds:

```ts
if ((msg.kind === "sub-ack" || msg.kind === "update") && msg.etag !== undefined) {
  entry.etag = msg.etag;
}
```

> **An ETag may accompany a frame only if that frame CARRIES the value the ETag describes.**

That is not merely an optimization. An `invalidate` frame carries no value; stamping it with an
etag would hand the client a signature *newer* than the value it still holds — precisely the
permanent stale pin the 2026-07-09 doc exists to kill. The server simply doesn't respect the
invariant in *where it computes*, and pays for it on every push.

Note that the **etag-after-value ordering on the push path is intentional and sound** for
value-carrying frames (see the comment at `runtime.ts:2206-2214`): the frame carries the value,
so a change landing between the value read and the etag read fires its own notify →
`flushAgain` → a fresh value+etag supersedes it. This change does not touch that. It is about
the branch that sends no etag at all.

## Design

Give `pushEtag` exactly one caller: a helper that co-locates the value and the etag in one
frame *and broadcasts it*. The `invalidate` and `delta` branches then *structurally cannot*
obtain an etag, because nothing else calls `pushEtag`.

### The second invariant: the no-`revalidate` path must not await

The old hoist reads `entry.revalidate ? await pushEtag(…) : undefined` — the `await` sits
**inside the ternary's true branch**, and its comment says so: *"Undefined — with NO await — for
a resource that never opted in, so the frames below are byte-identical to before."*

That is load-bearing, and it constrains the shape of the fix. A plain `async function
updateFrame(...)` that *returns* the frame for the caller to send forces `await updateFrame(…)`
at every site, which yields a microtask even when there is no etag to compute (awaiting a
non-thenable still defers one tick). Almost no resource declares `revalidate`, so that would
delay **every** push-mode send by a tick before it reaches the wire — and
`runtime-h5.test.ts` **H5a** (the notify-vs-fresh-sub race: a push must beat a racing parked
sub-ack) fails, correctly.

The cure is to move the broadcast *inside* the helper, so the no-etag path builds and sends with
no `await` anywhere on it. Only the etag path awaits, and its `.then` lands the frame on the wire
in the continuation the etag resolves in.

### 1. `sendUpdate` — the one place a push-path etag is computed

`plugins/framework/plugins/resource-runtime/core/runtime.ts`, added directly below `pushEtag`:

```ts
function sendUpdate(
  entry: RegistryEntry,
  params: ResourceParams,
  value: unknown,
  version: number,
  subs: SocketState[],
): void | Promise<void> {
  const broadcast = (etag?: string): void => {
    const msg = {
      kind: "update" as const,
      key: entry.key,
      params,
      value,
      version,
      ...(etag !== undefined ? { etag } : {}),
    };
    for (const s of subs) sendJson(s.ws, msg);
  };
  if (!entry.revalidate) {
    broadcast(); // sync send — no microtask before the wire (H5a)
    return;
  }
  return pushEtag(entry, params).then(broadcast);
}
```

The etag spread stays **last**, so the serialized frame is byte-identical to today's. On the sync
path the caller's `await sendUpdate(…)` resolves `undefined` — the tick lands *after* the wire
write, so send ordering is preserved and only the post-send accounting shifts by a tick, which
nothing observes.

Its doc comment must record **both** invariants (the etag-only-on-value-carrying-frames rule,
relocated from `drainEntry:2199-2214`, and the no-await sync-send rule naming H5a). Losing the
second one from the code is exactly how this fix first broke it.

`pushEtag` stays a named module-private function — it carries the ungated/fail-safe rationale
and an `eslint-disable-next-line promise-safety/no-absorbed-failure` pragma that would be noise
inside the helper. Its one-caller-ness is what enforces the invariant, and a test pins it
(§3, case 1).

### 2. Adopt it at the four `update` sites; delete the two hoists

- **`drainMembershipFull:1895`** — delete `const updateEtag = …`.
  **`:1899-1906`** → `await sendUpdate(entry, params, value, version, subs);`
- **`drainEntry:2215-2216`** — delete `const updateEtag = …`; relocate the `:2199-2214`
  rationale comment onto `sendUpdate`.
  - **`:2239-2246`** → `await sendUpdate(entry, params, full, version, subs);`
    — note the value binding here is `full` (the near-unreachable reload), not `value`.
  - **`:2277-2284`** → `await sendUpdate(entry, params, value, version, subs);`
  - **`:2305-2312`** → `await sendUpdate(entry, params, value, version, subs);`
- The `invalidate` literal (`:2218`) and all four `delta` literals (`:1910`, `:2049`, `:2255`,
  `:2288`) are left untouched, and now cannot reach an etag.

`sendUpdate` owns exactly two things: building the frame (value + etag together) and
broadcasting it. `opts.onPush?.(...)`, `diffKeyed`, `onDelivered` and `cascadeDownstream` stay at
the call sites, which genuinely differ there — `:2305` (push mode) calls neither `onPush` nor
`diffKeyed`, and `:2239` calls `diffKeyed(entry, pk, full)` first. Folding `onPush` in would
either force a call onto the push-mode site that it does not make today, or need a suppression
flag.

### Behavior deltas

- **`edited-files`** (`invalidate`): zero `revalidate` invocations on the push path, down from
  one per notify per subscribed conversation. Zero `push`-origin revalidate spans in the
  profiler. This is the win.
- **`jsonl-events`, `commits-graph.{delta,graph}`** (all `push` mode): still hit `:2305` →
  `updateFrame` → etag computed exactly as before. **Byte-identical wire frame.**
- **A throwing `revalidate` on an `invalidate` resource** no longer calls `reportLoaderError`
  once per push. That is an **improvement** — the report was about work whose result was
  discarded. The read path (`computeEtag` in `handleSub` / `handleResourceHttp`) still reports a
  broken signature, where the etag is actually consumed.
- **`drainEntry:2239`** is the one site whose ordering genuinely flips: today `updateEtag` is
  computed at `:2216`, *before* `full` is reloaded at `:2229`; after, it is computed after. That
  moves the etag from "older than the value" to "≥ the value's state", i.e. into the same
  relationship `:2277` and `:2305` already have, covered by the same push-path self-heal
  argument. The branch is also unreachable for every shipping resource (it needs keyed +
  `revalidate`; no keyed resource declares one). Consistency, not regression.
- No effect on `flushRunning` / `flushAgain`: the mutex lives in the scheduling layer around
  `drainEntry`, and the synchronous `entry.versions.set` bump precedes all etag work at every
  site.
- **No change to send timing** for a resource without `revalidate` — that is what the sync-send
  branch buys, and it is the reason `sendUpdate` broadcasts rather than returning a frame.

### 3. Tests — `plugins/framework/plugins/resource-runtime/core/runtime-revalidate.test.ts`

No existing test exercises `revalidate` on the push path (every case in `runtime-revalidate`,
`runtime.test.ts`'s revalidate block, `runtime-h5`, `runtime-scoped-routing`, `runtime-catchup`
drives `subscribe` / `handleResourceHttp` only). So nothing breaks — and nothing currently pins
either the bad behavior or the good one. Close both gaps with four cases, all DB-free via
`createHarness` + `defineExternalResource` (whose handle exposes `.notify()`), counting
`revalidate` invocations with a closure counter:

1. **`invalidate-mode notify never invokes revalidate`** — subscribe (the read path bumps the
   counter), snapshot it, `notify()`, tick; assert the counter is unchanged and the single
   `invalidate` frame has `"etag" in frame === false`. *This is the regression fence for the
   `edited-files` waste, and the structural invariant made executable.*
2. **`push-mode update still carries a co-produced etag on notify`** — advance both the value
   and the signature, `notify()`, tick; assert the `update` frame's `etag` is the fresh one.
   Guards against a future `sendUpdate` refactor silently dropping the `jsonl-events` etag.
3. **`a throwing revalidate is not reported on the push path`** —
   `createHarness({ reportError: spy })`, invalidate resource with a throwing `revalidate`.
   Subscribe (spy fires from the read path), reset, `notify()`, tick; assert the spy is not
   called. Pins the behavior delta above.
4. **`no-revalidate update sends synchronously — the push beats a racing parked sub-ack`** —
   a `push`-mode resource with **no** `revalidate`: park the loader, subscribe, `notify()`,
   release; assert `update.seq < subAck.seq` and `"etag" in update === false`. `runtime-h5`'s
   H5a pins the same ordering through the notify-vs-fresh-sub invariant; this co-guard lives in
   the file that owns the etag/push-path invariant and ties the ordering specifically to
   `sendUpdate`'s no-await branch, so a regression names its own cause.

A keyed-delta case isn't worth building: keyed + `revalidate` is unreachable today and
`defineExternalResource` doesn't produce a keyed contract, so the harness cost outweighs the
value. Cases 1–3 pin "a frame that does not carry the value never causes `revalidate` to run"
across every live-reachable path; case 4 pins the sync send.

**`runtime-h5.test.ts` must not be modified.** H5a's `update.seq < subAck.seq` assertion looks
like an implementation detail and is not: it is the tripwire for exactly the accidental
microtask this change nearly introduced. If it fails, the helper is wrong, not the test.

### 4. Document the delta asymmetry (`resource-runtime/CLAUDE.md`)

Out of scope to *implement*, load-bearing to *record* — because the two delta kinds look alike
and are not:

- **A keyed FULL delta** (`:2288`) and the **M5 membership deltas** (`:1910`, `:2049`) ship
  `upserts` + `deletes` + `order`. The client rebuilds its array purely from `order`, so after
  applying, **the client's value equals server truth**. An etag co-produced over that same
  snapshot would correctly describe what the client now holds — so a future change *could* let
  these carry one, keeping the client's stored signature fresh across pushes and turning the
  next resub into an `up-to-date` instead of a full reload.
- **A keyed SCOPED delta** (`:2255`) ships `deletes: []`, `order: undefined` — it deliberately
  does not assert membership or order. After applying, the client's array is **not** guaranteed
  to equal server truth. An etag here would let the next resub be answered `up-to-date` onto a
  client missing membership changes: a permanent partial-stale pin. It must **never** carry one.

This change gets both right for free — the etag can only ride the frame `updateFrame` builds —
and in particular excludes the dangerous scoped delta by construction. Enabling the safe half
later is separate work: the client would first have to store an etag from an `order`-bearing
delta (its `ServerMsg` union doesn't even declare the field today, so a server-stamped delta
etag is discarded on arrival), the FULL/membership delta would need its own co-producing
builder, and a guard would have to make the scoped path unable to reach it. None of it is needed
until a keyed resource actually declares `revalidate`.

## Verification

1. `bun test plugins/framework/plugins/resource-runtime/core/` — the three new cases plus the
   existing suites green (nothing there touches the push-path etag, so no churn is expected).
2. `./equin build`, then confirm the live win on `edited-files` at the seam, not the
   browser. Open a conversation with a worktree so `edited-files` is subscribed, then edit a
   file in that worktree to fire the watcher. Before the fix each notify runs a
   `getConversation` + 3 git spawns; after, none. Check with `get_runtime_profile` (MCP): the
   `push`-origin spans for `edited-files` should show the loader only, with no revalidate span —
   and `git status` invocations under the `push` origin should drop to zero.
3. `curl -s -D- 'http://<wt>.localhost:9000/api/resources/edited-files?id=<convId>'` still
   returns a fresh `ETag`, and a conditional GET with it still returns `304` — the read path is
   untouched.
4. Confirm the value-carrying frames are unchanged: with a conversation open, tail
   `~/.singularity/worktrees/<wt>/logs/` and check `jsonl-events` `update` frames still carry an
   `etag` (that resource is `push` mode, so this is the byte-identical path).
5. `./equin check` (type-check, plugin-boundaries, `plugins-doc-in-sync` after the
   CLAUDE.md edit).

## Ordered implementation

1. `runtime.ts`: add `sendUpdate` below `pushEtag`; move the `:2199-2214` rationale comment onto
   it and add the no-await sync-send constraint (naming H5a).
2. `runtime.ts`: delete the two `const updateEtag = …` hoists; route the four `update` sites
   through `sendUpdate` (watch the `full` binding at `:2239`).
3. `runtime-revalidate.test.ts`: add the four cases.
4. `resource-runtime/CLAUDE.md`: add the "an etag rides the `update` frame" invariant, the
   sync-send constraint, and the FULL-vs-scoped delta asymmetry.
5. `bun test plugins/framework/plugins/resource-runtime/core/` (all suites, H5a **unmodified**),
   then `./equin build && ./equin check`.

## Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts`
- `plugins/framework/plugins/resource-runtime/core/runtime-revalidate.test.ts`
- `plugins/framework/plugins/resource-runtime/core/test-support.ts` (`createHarness`, read-only)
- `plugins/framework/plugins/resource-runtime/CLAUDE.md`
- `plugins/primitives/plugins/live-state/web/notifications-client.ts` (read-only — the wire
  contract this change aligns the server to)
