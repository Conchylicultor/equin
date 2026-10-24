# Pane route form: remove the tax, close the footgun, fix the push-path drop

## Context

Commit `4392017c2` made a pane's identity one `RouteDef`, removing the legacy
`Pane.define({ id, segment, parent })` spelling. That was right — a `RouteDef` is pure data
the server can reach, so a notification's `linkTo` and a pane's URL come from one source.

It left four problems, all from the same cause: identity moved out of `Pane.define` into a
separate `defineRoute` call.

1. **A per-site tax a minority need.** 102 production panes each author a route; **78 of
   them are never read outside the file that declares them**, and only **5** are read from a
   `server/` file — the one reader class a web-only pane object could not serve. The commit
   was **+614 / −190 = net +424 lines** over the 69 route-declaring pane files.
2. **Writing the route inline silently produced a paramless pane.**
3. **Chained params are dropped on the `push` path**, and five comments claim otherwise.
4. **Dead residue** — an unreachable `PaneDeclaration.id`, plus stale hand-written prose.

The investigation changed the framing on three of the four. The corrections below are what
this plan is built on; each was verified against the code, not inferred.

### What changed about the framing

**Problem 1's premise is right, but every structural collapse is worse than the status quo.**
Four independent designs were built and adversarially critiqued:

- *Fold identity into `Pane.define`, generate the server's link table* — fatal. The table
  would bake in each pane's own `app`, but a `linkTo` deliberately links a pane into a
  **different** app: `run-state.ts:237` is `buildDetailRoute.link(agentManagerApp, …)` for a
  pane whose `app` is `debugApp`. Generating it would silently rewrite that URL.
- *Invert the core/web line* — measured a wash. The modal pane (71 of 102: paramless,
  ancestorless, non-index) is exactly the same line count after every inversion tried.
  The cost is **inherent to "identity must be constructible in a runtime that cannot see the
  component"**, not to where the line sits.
- *Fold `app` into `defineRoute`* — ≈ −46 lines against +424, and its enforcing check cannot
  be written soundly (`app:` is an imported identifier; the AST walk reads string literals
  only and has no import resolution).

So the two-call split stays. What can go is the *ceremony*, and it goes by writing the route
**inline** — which problem 2's fix makes type-correct.

**Problem 2 has a one-token fix that lands at rung 1.** Declaring
`defineRoute<const Seg extends string, …>` makes the inline form infer its literal correctly.
Verified against the real type machinery with the repo's own `typescript@6.0.3`: 16 route
shapes are byte-identical to today under a strict `Equal`, and an AST scan of all 141 real
calls found **0 inline, 0 non-literal segments, 0 explicit type arguments** — so the change
produces zero new errors on the current tree. It also converts the silent case into a loud
one: a paramful pane written inline with no `resolve` becomes a compile error.

**The real blocker on inlining is a parser nobody named.** Two source readers of
`defineRoute` exist and they disagree about robustness:

- `pane:segments-unique` (`pane/check/index.ts:25-62`) walks the **TypeScript AST** and
  matches a `defineRoute` call at any depth — fully inline-safe.
- The contributions facet (`static-parse.ts`) is a **hand-rolled text scan**.
  `routeDeclarationsIn` anchors on `DECL_RE = /(?:export\s+)?const\s+(\w+)\s*=\s*$/`
  immediately before the call and `continue`s on a miss; `paneDeclarationsIn` requires
  `route:` to be a **bare identifier**, and `identifierField` returns the literal string
  `"defineRoute"` for an inline call — a *phantom* ref that `routeIdOf` resolves to nothing.

The failure is fully silent, and `plugins-doc-in-sync` cannot catch it: `docs/plugins-details.md`
gets its pane lines from the **runtime** `docLabel`, so it stays green while the Studio
Contributions table, the plugin-detail card and the review PR diff (all `skipBarrelImport: true`)
lose every pane id. **Absorbing a parse failure into an absence is itself a fail-loudly
violation**, so this is worth fixing whether or not anything moves inline.

**Problem 3 is narrower and worse than stated.** Only **two** production routes have a
paramful ancestor, and exactly **three** call sites pass an ancestor key. Two are benign.
The third, `open-run.ts:38`, is a live crash: `RunsDataView` has **three** hosts, not one —
from `BuildButton`/`ActionBar.Item` (global chrome) `serverId` is load-bearing, but from
`build-popover-content.tsx:299` inside `buildPane` and `backup-panel.tsx:107` inside the
backup pane it is **dropped**, leaving a deployment pane with no server ancestor and a
`/debug/dep/<id>` URL. Its Expand button then re-roots, `openPaneImpl` mints
`createSlot("deploy-server-detail", {})`, and `buildRouteUrl` throws `MissingRouteParamError`
uncaught — **after** `setRoute` has already mutated the store and notified (`pane.ts:634-635`
vs `:637`).

**Problem 4's "dead residue" turns out to be the carrier for the new shape.**
`PaneDeclaration.id` is genuinely unreachable today, but the inline form has no route
identifier to resolve — its id lives in the nested `defineRoute({ id })`. So the field is
revived with a corrected meaning rather than deleted.

---

## Stage 1 — the producer fix and two type constraints

Zero call-site churn. Independently landable.

**`plugins/primitives/plugins/pane/core/route.ts:231`** — add the `const` type-parameter
modifier:

```ts
export function defineRoute<
  const Seg extends string,
  ParentParams extends Record<string, string> = {},
>(def: { id: string; segment: Seg; parent?: RouteDef<ParentParams, any> })
```

**`plugins/primitives/plugins/pane/web/pane.ts`** (`RouteDefineArgs`, ~:1910-1978) — make
`appIndex` legal only on a segment-less route, turning today's registry-sync throw into a
tsc error:

```ts
type AppIndexField<Seg extends string> =
  Seg extends "" | "/" ? { appIndex?: boolean } : { appIndex?: never };
```

Keep both runtime throws in `useSyncPaneRegistry` (`pane.ts:2088-2105`): they still guard the
untyped `AnyPane` path, and the *second index per app* invariant is cross-file, which no type
sees. `plugins/primitives/plugins/pane/web/__tests__/app-index.test.tsx:100-121` deliberately
constructs the illegal combination to assert the throw — add `@ts-expect-error` above its
`Pane.define` and keep the runtime assertion.

**Do not make `segment` optional.** It types cleanly but re-opens the exact class the `const`
fix closes: `segment: undefined` silently infers `string`. The 11 `appIndex` panes keep
`segment: ""`, which now *earns its keep* — it is what permits `appIndex: true`.

**Also in Stage 1:** rename `PaneInternal.defaultAncestors` (`pane.ts:212`) to
`parentPaneIds: string[]`. It is a pointless re-wrap of `route.parentPaneIds`
(`pane.ts:2007`), Stage 4 gives it a second consulted meaning, and the name is what five
prose passages describe as an authored field. Renaming makes that prose obviously stale.

## Stage 2 — make the docgen parsers honest

The enabling work for Stage 3, and a fail-loudly fix on its own.

**`plugins/plugin-meta/plugins/facets/plugins/contributions/facet/internal/static-parse.ts`**

- `identifierField` (:299-308) must reject an identifier immediately followed by `(` — today
  it mints `route: { name: "defineRoute" }` for an inline call.
- `paneDeclarationsIn` (:384-407) gains an inline arm: when `route:`'s value is a
  `defineRoute(` call, read the nested object's `id` into `pane.id`. The existing helpers
  align exactly — `topLevelFieldOffset` returns the value's first character offset and
  `markerCallSpans`'s `identifier` is the marker's first character in the same buffer, so
  `spans.find(s => s.identifier === at)` lands on the nested call.
- **Make the miss loud.** `if (pane.id || pane.route) out.push(pane)` (:403) silently drops a
  `Pane.define` the scanner cannot name. A `Pane.define` whose identity is unreadable is a
  docgen failure, not an absence — throw with the file and the declaration name.
- `routeDeclarationsIn` (:334-348) is unchanged: it only ever needs to name *shared* routes,
  and an inline route has no identifier to resolve.

**`plugins/plugin-meta/plugins/facets/plugins/contributions/core/types.ts:53-62`** — keep
`PaneDeclaration.id`, rewrite its doc comment: it is now the id read off an inline route, not
a legacy literal. Update the four dead comment blocks (`static-parse.ts:373-378`,
`types.ts:57-58`, `facet/index.ts:406-408`, `static-parse.test.ts:48-52`).

**`static-parse.test.ts`** — re-spell `:91-101` (`"legacy form: the literal id on the call"`)
as the inline-route case, and `:164-170` with `route:` so it keeps its teeth (it would pass
vacuously otherwise).

### Stage 2b — the identity manifest check (the missing verification)

`appIndex` has **no static check at all** today, and nothing anywhere pins a pane's id or
segment. Extend `plugins/primitives/plugins/pane/check/index.ts` — already a TS AST walk over
`listCandidateSources({ grepArg: "defineRoute" })` — with a second `Check`,
`pane:identity-manifest`, that emits `(paneId, segment, appIndex)` for all 102 panes and
compares against a committed snapshot, in the shape of `migrations-in-sync` /
`plugins-registry-in-sync`.

Ancestors are deliberately out of the manifest: `parent:` is a cross-file identifier this walk
cannot resolve. They are covered instead by the fact that a hoist→inline move never edits a
`parent:` edge — assert it with `git diff -G'parent:' $(git merge-base HEAD main)` returning
empty.

Note: reorder config directives are keyed by the plugin's `slots:` record **key**, not by the
pane id (`declaration.ts:134-136`, `descriptors.ts:80-85`) — the key equals the pane id only
by convention. So `history.state` is the identity consumer that matters, and the manifest is
what guards it.

## Stage 3 — inline the file-local routes

Gated on Stages 1 and 2b being green.

**71 routes move inline** (the LOCAL class — a non-exported const whose only reader is the
`Pane.define` below it). **31 stay hoisted**, because they are genuinely read more than once:
7 named as a `parent:` in the same file, 5 read from `server/`, 5 cross-file parents, 9 whose
pane lives in another file, 5 with an off-file `.link()`/`.path()`.

Re-export `defineRoute` from `plugins/primitives/plugins/pane/web/index.ts` so the 69 affected
files drop a whole import line. This is legal and precedented: barrel purity accepts
`export { … } from` (`plugin-boundaries/check/index.ts:700`), and the cross-plugin-reexport
rule stops at `LOCAL` for a same-plugin relative specifier (`reexport-provenance.ts:363-369`).
48 barrels already re-export from their own core, ~25 of them values —
`plugins/primitives/plugins/rank/web/index.ts:3` is the closest match.

Add a canonical-path lint rule so two import paths do not become two spellings; the exact
shape exists in `no-adhoc-check-runner` (specifier + imported name + owner-file exemption).
Rank is the cautionary tale here: its own hand-written CLAUDE.md still points at a `shared/`
directory that no longer exists.

The pattern, applied 71 times (e.g. `plugins/debug/plugins/queue/web/panes.ts`,
`plugins/apps/plugins/agent-manager/plugins/welcome/web/panes.tsx`,
`plugins/apps/plugins/studio/plugins/explorer/web/panes.tsx`):

```ts
// before — two imports, a hoisted const nothing else reads
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { defineRoute } from "@plugins/primitives/plugins/pane/core";

const queueRoute = defineRoute({ id: "queue", segment: "queue" });

export const queuePane = Pane.define({ route: queueRoute, app: debugApp, component: QueueView });

// after — one import, one declaration
import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";

export const queuePane = Pane.define({
  route: defineRoute({ id: "queue", segment: "queue" }),
  app: debugApp,
  component: QueueView,
});
```

Expect a large but mechanical docgen diff: the cross-refs facet currently drops web→core uses
(`cross-refs/facet/index.ts:129`), so ~69 plugin CLAUDE.md files gain a `primitives/pane.defineRoute`
Uses line once the import moves to `pane/web`.

## Stage 4 — the push path

One rule: **an open never discards a param the caller supplied.**

In `plugins/primitives/plugins/pane/web/pane.ts`, replace the three hand-rolled slot builders
in `useOpenPane` — swap (:2414-2421), push-left (:2430-2435), push-right (:2441-2445) — and
`openPaneImpl`'s ancestor loop (:879-894) with one shared helper:

- `chainSlots(target, params, prefix, { fromScratch })` — from scratch, materialize the whole
  declared chain (unchanged). Relative, materialize only declared ancestors the prefix lacks
  **and that carry a `:param`**. That second clause is derived, not special-cased: a slot
  carries only its own segment's names, so a paramless ancestor carries nothing and inserting
  it would add a column nobody asked for. It is also the right cut empirically — of the 39
  relative sites targeting a pane with ancestors, **36 have paramless ancestors** (a task chip
  would otherwise drag the whole task-tree column in beside it).
- `prefixHosts(prefix, target, params)` — false when the prefix already holds a declared
  ancestor with a *different* value, falling back to the from-scratch build. A run row for
  server B listed inside server A's page is ordinary data, not a programming error, so this is
  a fallback and not a throw. The same predicate gates `openPaneImpl`'s in-place dedup
  (:853-877), which today replaces the target slot and keeps the stale ancestor — "click a
  deployment on a different server and the route keeps the old `serverId`", which nothing
  currently catches.

**Leave alone, both verified to regress:**

- The swap no-op guard (`targetInternal.id === callerPaneId && sameParams && sameOptions`) and
  push-right's unconditional `setRoute`. Replacing them with a `routesEqual` universal bail
  remounts all 13 swap sites and silently changes re-click semantics on ~90 pushes.
- Mode-keyed `OpenPaneFn` overloads. Verified `TS2769`: `useToggle` forwards a runtime-valued
  `PaneOpenMode` (`pane.ts:1787` → `:1819-1824`), and `launch-control.tsx:100` passes
  `openMode: PaneOpenMode`.

**Behaviour changes at exactly one call site**: `open-run.ts:38`, from its two in-pane hosts.
The deployment pane gains its server ancestor — a correct URL and a working Expand, at the
cost of one extra Deploy column rendered inside Debug. That column mounts
`serverDetailPane`'s `resolve: useResolveServer` and its `serversResource` subscription;
accepted deliberately, as the alternative is the uncaught throw described above.

Add a jsdom regression suite under `plugins/primitives/plugins/pane/web/__tests__/` covering:
push with a paramful ancestor absent from the prefix; push with a paramless ancestor absent
(must **not** materialize); `prefixHosts` false → from-scratch fallback; and the promote path
that throws today.

## Stage 5 — residue and stale prose

**Comments that assert the wrong contract** (all attached to a `mode:"push"` call):
`open-run.ts:14-17` and its mirror in `runs-arm/CLAUDE.md:41-46`; `runs-section.tsx:145-147`;
`runs/web/panes.tsx:33-37`.

**`plugins/primitives/plugins/pane/CLAUDE.md`** — three fixes:
`:200-202` documents `pane.open(params)`, which `PaneObject` has no member for (interface at
`pane.ts:1497-1552`); `:216` says `side: "left"` is "skipped if already an ancestor" — it is
not, control falls through to the right-push at `:2441-2445`; `:222-227` says a caller-less
open behaves as `"root"` — it passes `root: false`, so `openPaneImpl`'s dedup branch runs
first, which `"root"` skips entirely.

**Seven hand-written markdown passages**, all above their `AUTOGENERATED:BEGIN` fence:
`events/sources/CLAUDE.md:119-120`, `mail/search/CLAUDE.md:31-32` (stale on two fields, and
still says `input`), `studio/…/draft-actions/CLAUDE.md:13-14`, `agent-manager/pages-nav/CLAUDE.md:10`,
`pane/CLAUDE.md:20`, plus two the original report missed:
`facets/plugins/contributions/CLAUDE.md:26-28` (stale at birth — added by `4392017c2` itself)
and `mail/reading-pane/CLAUDE.md:18` (attributes `segment:` to `Pane.define`).
`deploy/deploy-history/CLAUDE.md:44-52` is separately stale — `releaseDetailPane` was
re-parented to the paramless `compositionsRoute`.

No check for these: `plugins-doc-in-sync` copies the prose prefix through verbatim on both
sides of its equality (`docgen.ts:276-305`), so it can never differ. A `grepCode` rule over
`["**/CLAUDE.md"]` is possible (`grep-code.ts:38-40` already takes pathspecs, and
`no-hand-built-link-to` is the exact-shape precedent) but would only ban a token, not a claim.
Fix the prose; do not add the check.

## Deliberately not doing

Folding identity into `Pane.define` with a generated server link table (bakes in the wrong
app); inverting the core/web split (measured a wash, and trades rung 2 for rung 3/4); folding
`app` into `defineRoute` (−46 vs +424, unsound check, breaks 39 test call sites); optional
`segment`; `.route` on `PaneObject` (verified to re-open the stray-key hole `Closed<>` exists
to close — `pane.route.link(app, { bogus })` compiles for 64 of 102 routes); a
`no-unshared-route-const` lint (satisfied by typing `export`, and nothing in ~90 checks
detects an unused export).

## To confirm separately

`plugins/build/server/internal/run-state.ts:237` builds
`buildDetailRoute.link(agentManagerApp, …)` → `/agents/build/r/<id>`, but `buildDetailPane.app`
is `debugApp` (`/debug`). It is the only mismatch among the five server link sites, and
`resolveRoute` does no app filtering, so the pane renders inside Agent-manager chrome rather
than 404ing. Possibly deliberate; out of scope here.

## Execution

Every code-writing stage is delegated to an **Opus** subagent; only lookup/verification runs
on Sonnet. Sequencing is forced by two shared files — Stages 1 and 4 both edit
`pane/web/pane.ts`, and Stage 3 edits every file Stage 1's type change affects.

| Wave | Agents | Stages |
|---|---|---|
| 1 | 3 in parallel | **1** (`route.ts` + `pane.ts` types + rename) · **2** (facet parsers + tests) · **5** (comments + 7 prose passages) |
| 2 | 2 in parallel | **2b** (`pane:identity-manifest` check, snapshot taken from the pre-Stage-3 tree) · **4** (`chainSlots` / `prefixHosts` + jsdom suite) |
| 3 | 1 + fan-out | **3** — one agent does the `pane/web` re-export and the canonical-path lint rule, then the 71 inline conversions fan out across disjoint plugin subtrees |

Wave 3 does not start until `pane:identity-manifest` is committed and green — it is the only
thing that makes a 71-file identity-touching diff verifiable.

## Verification

1. `./equin check` after each stage — `type-check`, `pane:segments-unique`,
   `pane:identity-manifest`, `plugins-doc-in-sync`, `plugin-boundaries`, `eslint`.
2. **Identity invariant.** `pane:identity-manifest` must report no drift across Stage 3, and
   `git diff -G'parent:' $(git merge-base HEAD main)` must be empty for the pane files.
3. `./equin test plugins/primitives/plugins/pane` — `pane-write-path-types.test.ts`
   (every `@ts-expect-error` must still fire), `app-index.test.tsx`,
   `open-pane-global-chrome.test.tsx`, and the new Stage 4 suite.
4. `./equin test plugins/plugin-meta/plugins/facets` for the re-spelled parser tests.
5. `./equin build`, then
   `./equin run plugins/primitives/plugins/pane/e2e/app-index-sweep.ts` — must stay
   green; it is the only runtime coverage of `appIndex`.
6. **Stage 4 by hand**, at `http://<worktree>.localhost:9000`: open Debug → Builds, click a
   deploy row in the merged runs list, confirm the Deploy server column appears, the URL
   carries `server/<id>`, and Expand works. Repeat from the global action-bar build popover
   (no caller) and confirm it is unchanged.
7. **Facet output**, the thing that fails silently today: open Studio → Contributions and
   confirm every `Pane.Register` row still shows its pane id after Stage 3. Cross-check
   `docs/plugins-details.md` is byte-identical apart from the expected `defineRoute` Uses
   lines.
