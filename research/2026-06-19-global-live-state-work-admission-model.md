# Live-State Work-Admission — the global mental model

> North-star + mental model for why equin keeps getting slow, gets patched,
> and gets slow again — and the single structural change that makes "fast" an
> invariant the architecture *defends* rather than a state agents *restore by hand*.
>
> Written after a live diagnosis of the `singularity` main backend (2026-06-19):
> `config-v2.scopes` resolved thousands of times (max 365 s), pool `[acquire]`
> count 60,681, `[loader-acquire]` max 45 s, git loaders `edited-files`/`commits-graph`
> 19–68 s behind a 2-slot host-wide gate, 688 inert dead jobs, multiple idle
> backends doing perpetual work. The UI was minutes stale on a conversation that
> was already correctly `done` in the DB.

## 1. The vision

"Fast, and stays fast" is **not** an outcome you reach by fixing slow things. It is
an **invariant the runtime enforces**: *the system never does work it cannot
justify.*

- **At rest it costs ≈ nothing.** No subscriber, no change ⇒ no work. The fan is
  silent because there is literally nothing to do.
- **Under load, total work is bounded, accounted, and attributable.** Every unit of
  work entered through one place that counted it.
- **Cost cannot silently re-accumulate.** Adding un-admitted work is a *type error,
  a failed check, or a tripped budget* — not a review someone might miss.

The job is to move "fast" from the **outcome** column to the **invariant** column.

## 2. The mental model: two phases, not many concerns

The live-state pipeline has exactly **two** phases. Almost every "performance
concern" people enumerate is one of these two viewed through a narrower lens.

- **Pull** — read a resource value, dedupe concurrent reads, deliver to subscribers.
  *Already unified and enforced* (`getResourceValue` + single-flight; one
  `flushNotifies`; keyed-delta wire protocol "Layer 1").
- **Push / work-admission** — decide *whether* a recompute may run, *how scoped* it
  is, *how many* run at once, and *count* it. **This is the missing primitive.**

A common "six concerns" inventory —

| Concern | Choke point | Enforced? |
|---|---|---|
| Resource reads | `getResourceValue` + single-flight | ✓ |
| Delivery | `flushNotifies` | ✓ |
| DB concurrency | caller-kind gate at `pool.query` | partial (DB only) |
| Loader recompute cost | `debounceMs` exists | ✗ 3 of 27 loaders adopt it |
| Periodic work | — | ✗ 17 ad-hoc `setInterval` |
| Heavy git reads | `withHeavyReadSlot` | opt-in (6 sites) |

— is **the surface-decomposition bias in table form.** It is organized by
*pipeline phase / resource type*, the cut that yields six independent tasks.
Re-cut by *work lifecycle*, the bottom four rows are **one absent object** (the
recompute scheduler) seen through four lenses — cost, timers, git slots,
cross-work concurrency. Rows 1–2 are the already-done pull side. **Two concerns,
one of them done.** When a problem reads as "N independent efforts," suspect the
cut, not the count.

## 3. The core reframe: the runtime has no model of *work*

The runtime models **correctness and composition** beautifully — slots,
contributions, `dependsOn`, single-flight, keyed deltas. It has **no model of
work.** Any plugin can:

- define a loader that does arbitrary work,
- fire `notify` from anywhere,
- add a `dependsOn` edge,
- subscribe from N components,
- spin a timer.

…and **nothing knows or bounds the total work per unit time.** Cost is the emergent
sum of dozens of independent local decisions, and **nothing owns the sum.** That is
why slowness can only ever be fought reactively, one hot spot at a time, forever.

## 4. Every symptom is the *same event*

> A recompute ran that shouldn't have, or cost more than it should.

| Observed symptom | The single event behind it | Admission lever |
|---|---|---|
| `config-v2.scopes` thousands of runs at idle | recompute fired with no change | skip-if-unchanged |
| `conversationsLive → attempts → tasks` cascade amplification | one notify ⇒ full downstream recompute | scope to changed key |
| `edited-files` / `commits-graph` re-run on every event | recompute on every trigger, full fan-out | coalesce + scope |
| Fan spins at rest, no agent running | recomputes/timers fire with no subscriber | admit-only-if-subscribed |
| UI minutes stale after close/push | recompute work blocks the delivery flush | move work off the flush |

Five "bugs," one missing concept.

## 5. The structural fix: recompute as a first-class admitted operation

Replace *"notify → immediate cascade recompute"* with *"notify → enqueue a recompute
**intent** on one scheduler."* That scheduler is the **sole way work enters the
system**, and the only place that:

- **admits** — skip if no subscriber; skip if inputs unchanged (content/version
  stamp). *Zeroes idle cost.*
- **coalesces** — collapse N intents for the same resource+key in a window. *Kills
  cascade amplification and config thrash, universally.*
- **scopes** — recompute only the changed key, not all rows. *This is the deferred
  "Layer 2 scoped recompute" — made mandatory, not opt-in.*
- **bounds** — one concurrency gate, subsuming the scattered DB / heavy-read /
  loader semaphores.
- **accounts** — every recompute is counted, because it is the single funnel. *The
  missing observability is free.*

This is **less** code in aggregate: the 17 timers collapse into the scheduler, the
per-loader semaphores delete, bespoke debounce adoptions and the wedge-watchdog
hacks become one property of one component. **Idle-quiescence stops being 17 fixes
and becomes one fact:** no subscriber ⇒ no admission ⇒ no work.

The other phases were *already* unified — reads (`getResourceValue`), delivery
(`flushNotifies`), DB-concurrency (caller-kind gate). **The one unification never
done is recompute scheduling — and it is the surface every symptom routes through.**
That is why fixing the read path and the delivery path didn't help: *work does not
enter through those; it enters through recompute.*

## 6. Enforcement: invisible discipline decays

A choke point without enforcement re-fragments by the next change, because *"did you
route through it?"* is invisible at author-time. The repo already proves the cure
for transport (`no-raw-websocket`, `no-raw-event-source`, `no-raw-sse`,
`no-use-resource-cast` are build-gating checks); it was simply never applied to the
perf primitives. Enforce in three layers of decreasing strength:

1. **Mandatory by construction (strongest — no raw alternative exists to ban).**
   A loader cannot run except via the scheduler, because the scheduler *hands it
   its only means of doing work* (its DB handle, its git slot) — capability-style.
   `defineResource` **requires** a recompute policy (`scoped` + coalesce window);
   a naive full-recompute-on-any-notify is **not expressible.** Beats a lint rule
   because the type system never offers the bypass. (Contrast: `debounceMs` is an
   optional field → 3/27 adoption.)
2. **A check for the residual** types can't express — `no-ad-hoc-setInterval`,
   `no-raw-git-spawn-in-request-path` — mirroring the existing transport checks.
3. **A runtime budget that fails loud.** Under a load/CI harness, assert the
   emergent invariant directly: *idle recompute volume ≈ 0*, *notify→deliver p99 <
   X*. Break the build the way crashes already file tasks. **This is the layer that
   catches erosion** — a future loader that re-introduces cost trips it in CI, not
   in production three weeks later. It gives the global property an owner.

> Types make the wrong thing **unwritable**; checks make it **uncommittable**; a
> budget makes its re-emergence **undeployable.**

## 7. What this does NOT fix (the honest residual)

Admission controls *frequency × fan-out × concurrency* — ~90% of the measured
contention. It does **not** reduce the **intrinsic cost of a single recompute.**
After admission, `edited-files` is still 4 git subprocesses and `commits-graph`
still 5 — running far less often, each call unchanged. Shrinking that is a genuinely
**orthogonal, irreducibly per-loader** axis (compute the delta, not the whole
graph). The model *minimizes* it (a scoped recompute touches one key, not 2268
rows) and, crucially, makes it **visible** — the scheduler counts every recompute,
so the few intrinsically-expensive ones stand out by construction instead of hiding
in an emergent sum.

## 8. Why prior fixes didn't hold — the deeper issue

This is **not an analytical failure.** The diagnosis was correct *months* ago —
`research/2026-06-04-global-conversations-live-cascade-amplification.md` already
named the O(all-history) view recompute; `2026-06-06-…-layer2-scoped-recompute-gate.md`
designed the fix and **deferred it pending evidence that has since arrived.** Smart
agents found the right answer repeatedly and still didn't land it. The failure is
**structural-incentive**, and it reproduces in anyone — including a fresh analyst:

1. **The medium shapes the solution.** An agent's unit of action is "a task that
   edits files," so every problem is reshaped into *a set of surfaces to patch* —
   because that is the native output. A problem whose real fix is "introduce a
   missing concept" doesn't fit the mold and gets approximated as "patch the places
   the concept would have covered."
2. **Legibility bias.** Slow loaders are measurable, nameable, fileable. The
   **absent abstraction is illegible** — visible only by noticing every legible
   problem shares one shape. First passes optimize the legible hot spot and are
   blind to the structural absence.
3. **No one owns the whole.** Task scoping, plugin boundaries, review-by-diff —
   every incentive is local. There is no file, role, or check whose job is "the
   global cost," so it is everyone's concern and nobody's task.

The architecture optimizes for composition and local correctness and has **no
first-class notion of global cost — the one thing it therefore cannot defend.**
Agents were structurally steered toward adding legible patches around an illegible
absence, against a default that makes touching the core the hardest move. The third
enforcement layer (§6) exists precisely to fix *this*: make global cost an owned,
gated invariant, so the next change is **forced to confront it** rather than
**allowed to add around it.**

## 9. The durable invariants

1. **Work enters the system in exactly one place.** No recompute runs except through
   the scheduler; no periodic work except through the scheduler; no heavy read
   except via a slot the scheduler hands out.
2. **No subscriber, no change ⇒ no work.** Admission is the default-deny.
3. **A recompute touches only what changed.** Scoped, not full-array, by
   construction.
4. **Delivery never blocks on computation.** The flush ships last-known values;
   recompute is async and accounted elsewhere.
5. **Cost is a tested number, not a hope.** Idle-recompute-volume and
   notify→deliver-latency are CI-gated budgets.
6. **Every choke point has an enforcing check.** A primitive without enforcement is
   considered unfinished.

## 10. Map to existing code (where the line is today)

**Done (pull side):** `getResourceValue` + single-flight (`2951c3624`); unified
`createResourceRuntime` (`39d04ddff`); caller-kind DB gate (`27f5f33d4`); keyed
delta wire "Layer 1" (`c2da7a50b`); `withHeavyReadSlot` primitive (`2ab5a3817`).

**Missing (push side / work-admission):**
- the recompute **scheduler** (admit / coalesce / scope / bound / account) — the
  one primitive; **"Layer 2" scoped recompute is the deferred core of it.**
- **full adoption**, by construction: all 27 `defineResource` sites carry a
  recompute policy (today 3 use `debounceMs`).
- one **scheduler for periodic work**, subsuming the 17 `setInterval` sites; this
  is the only place idle-quiescence can be implemented once.
- the **enforcement checks** (`no-ad-hoc-setInterval`,
  `no-raw-git-spawn-in-request-path`, required-recompute-policy type).
- the **CI cost-budget gate** (idle recompute ≈ 0; notify→deliver p99).

Each of these is a **deletion or a trivial adoption** under the scheduler — or proof
the primitive isn't done yet. None is an independent perf project.
