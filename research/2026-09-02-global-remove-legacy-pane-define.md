# Remove the legacy segment form of `Pane.define`

## Context

`Pane.define` has carried two overloads since the route form landed, discriminated on
`"route" in args` (`plugins/primitives/plugins/pane/web/pane.ts:1998-2018`):

- **Route form** — `Pane.define({ route: someRouteDef, … })`. Identity (`id` / `segment` /
  `defaultAncestors`) is derived from a `RouteDef` built by `defineRoute()`
  (`plugins/primitives/plugins/pane/core/route.ts:177`). Params are the full **chained** set,
  and the pane gets a `.link(app, params)`.
- **Legacy form** — `Pane.define({ id, segment, defaultAncestors, … })`. Params are
  `ParentParams & InferParams<Path>`, where `ParentParams` appears only in contravariant
  positions and therefore **always resolves to its default `{}`**.

The legacy form costs three things.

**Ancestor params are unspellable, so a legacy pane is only openable from its own parent's
page.** The runtime is ready — `openPaneImpl` fills each ancestor's params via
`extractOwnParams` (`pane.ts:906-921`, `pane.ts:1346-1356`) and would happily accept a
`serverId`. The type won't let anyone pass one. So an ancestor's params can only ever be
*inherited* from a route that already contains the ancestor; open the pane from anywhere else
and the ancestor gets `{}` and its `resolve` reports not-found — or, on a live store,
`buildRouteUrl` → `fillSegment` **throws** `Missing param` (`route.ts:101-103`).

`eventSourceRunPane` (`plugins/apps/plugins/events/plugins/sources/plugins/source-detail/plugins/runs/web/panes.tsx:48`)
is the one live instance: `run/:runId` under `eventSourceDetailPane` (`source/:sourceId`). Its
own doc comment rationalises the limit as a design decision — *"Pane params are **own-only** …
this pane sees `runId` and nothing of its ancestor's `sourceId`"* — which is the workaround, not
the reason. Every other legacy pane with a paramful ancestor would have the same defect; there
just aren't any others yet, so the rest is latent.

The deploy arm is the worked precedent for the fix, not a remaining victim: the task brief calls
`deploymentDetailPane` legacy, but it was converted, and
`plugins/apps/plugins/deploy/plugins/deployments/plugins/runs-arm/web/internal/open-run.ts:11-22`
now records *"the whole deploy pane chain had to become route-form first: the legacy segment form
typed a pane's params as its own segment's only, so the ancestor's `serverId` was unspellable and
this could not exist."*

**No `RouteDef` means no `.link()`, so cross-app Expand degrades silently**
(`plugins/primitives/plugins/pane/CLAUDE.md:549-551`).

**Identity is authored three times** — `id`, `segment`, `defaultAncestors` must agree by hand.

**Intended outcome:** the legacy form has no spelling. Deleting the `DefineArgs` overload makes
`Pane.define({ id, segment })` fail on a missing required `route` — rung 1 of the ladder, so no
lint or check guardrail is needed or wanted.

### Census (AST-derived, three agents concurring)

| | count |
|---|---|
| `Pane.define` call sites | **125** (the brief's 126th is a string fixture in `no-adhoc-binding-scan.test.ts:54`) |
| route form | 22 |
| legacy — product | **80**, across 67 files |
| legacy — test fixtures | **23**, across 10 files |
| legacy with `defaultAncestors` | 14 — **all single-element, all same-app** |
| legacy `appIndex: true` (no segment) | 10 |
| legacy with a paramful own segment | 26 — **all 26 already declare `resolve`** |

Three facts that shrink the job below what the brief assumes:

- **A route needs no `core/routes.ts`.** `defineRoute` is legally called from a web file; two
  panes already do (`plugins/config_v2/plugins/settings/web/internal/panes.tsx:12`,
  `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/panes.tsx:18`). Per-site cost is
  ~5 added lines *in the same file*.
- **Only 5 of the 14 ancestor edges cross a plugin** (3 auth setup wizards → `accountsPane`;
  `executionDetailPane` → `definitionsRootPane`; `eventSourceRunPane` →
  `eventSourceDetailPane`). The other 9 are same-file.
- **Zero new required fields.** `RouteResolveField` keys `resolve` off the *chained* params, so a
  paramless child of a paramful parent would newly owe one — but every ancestor except
  `eventSourceDetailPane` is paramless, and its only child already declares `resolve`.

---

## What changes, concretely

Canonical example: the events-sources chain — the only 3-deep chain, and the one live defect.

### Before

`plugins/apps/plugins/events/plugins/sources/web/panes.tsx:10-42`

```tsx
export const eventSourcesPane = Pane.define({
  id: "event-sources",
  app: eventsApp,
  segment: "sources",
  component: EventSourcesPaneView,
  width: 380,
});

export const eventSourceDetailPane = Pane.define({
  id: "event-source-detail",
  app: eventsApp,
  defaultAncestors: [eventSourcesPane],
  segment: "source/:sourceId",
  component: EventSourceDetailPaneView,
  resolve: useResolveSource,
  width: 460,
});
```

`…/source-detail/plugins/runs/web/panes.tsx:48-57`

```tsx
export const eventSourceRunPane = Pane.define({
  id: "event-source-run",
  app: eventsApp,
  defaultAncestors: [eventSourceDetailPane],   // ancestor needs :sourceId
  segment: "run/:runId",
  component: EventSourceRunPaneView,
  resolve: useResolveRun,
  useTitle: useRunTitle,
  width: 460,
});

// eventSourceRunPane.useParams()  →  { runId: string }        ← sourceId unspellable
// openPane(eventSourceRunPane, { runId })                     ← compiles, ancestor gets {}
// eventSourceRunPane.link                                     ← does not exist
```

### After

Routes are hoisted immediately above the panes they name, in the **same file** (see *Route
placement* below). The sources file gains:

```tsx
const eventSourcesRoute = defineRoute({ id: "event-sources", segment: "sources" });

/**
 * One source, under the sources list. Chaining is what puts the list segment in
 * the URL AND types a descendant's params as the full `{ sourceId, … }`.
 */
export const eventSourceDetailRoute = defineRoute({
  id: "event-source-detail",
  segment: "source/:sourceId",
  parent: eventSourcesRoute,
});

export const eventSourcesPane = Pane.define({
  route: eventSourcesRoute,
  app: eventsApp,
  component: EventSourcesPaneView,
  width: 380,
});

export const eventSourceDetailPane = Pane.define({
  route: eventSourceDetailRoute,
  app: eventsApp,
  component: EventSourceDetailPaneView,
  resolve: useResolveSource,
  width: 460,
});
```

and the runs file:

```tsx
const eventSourceRunRoute = defineRoute({
  id: "event-source-run",
  segment: "run/:runId",
  parent: eventSourceDetailRoute,      // ← imported from …/sources/web
});

export const eventSourceRunPane = Pane.define({
  route: eventSourceRunRoute,
  app: eventsApp,
  component: EventSourceRunPaneView,
  resolve: useResolveRun,
  useTitle: useRunTitle,
  width: 460,
});

// eventSourceRunPane.useParams()            →  { sourceId, runId }   ← chained
// openPane(eventSourceRunPane, { sourceId, runId })                  ← both required
// eventSourceRunPane.link(eventsApp, { sourceId, runId })
//                                           →  "/events/sources/source/<s>/run/<r>"
```

Three authored fields collapse to one; the ancestor's param becomes part of the child's type; the
pane gains a URL it can hand out.

---

## Step 1 — Fix two type defects in the route form, before converting anything

The route form is today, in two specific ways, a *weaker* type than the legacy form. Converting
80 panes onto it without fixing these spreads both defects. Both fixes were compiled clean by a
verifier agent against the real `pane.ts` / `route.ts` under `--strict`.

### 1a. `Closed<>` — restore the closed empty-param set

`InferParams<"">` normalises to `Record<string, never>` (`route.ts:23-27`); `RouteParams<"">` is a
bare `{}` (`route.ts:36-38`) — deliberately, so `ParentParams & RouteParams<Seg>` does not collapse
to `never`. Consequence, verified against the real types:

```
openPane(routeParamless,  { foo: "x" }, { mode: "root" })   // NO ERROR   ← route form
openPane(legacyParamless, { foo: "x" }, { mode: "root" })   // TS2322     ← legacy form
routeParamless.useToggle({ foo: "x" })                      // NO ERROR
```

So ~54 paramless product panes would silently lose their stray-key guard, and the build breaks:
`plugins/primitives/plugins/pane/web/pane-write-path-types.test.ts:85-86` and `:109-110` are
`@ts-expect-error` directives asserting exactly that rejection, and an unused directive is `TS2578`.

**Fix** — a normaliser applied only at the `PaneObject` boundary, leaving `{}` inside the `RouteDef`
chain where it must stay:

```ts
type Closed<P> = keyof P extends never ? Record<string, never> : P;
```

Verified: re-rejects the stray key, still accepts `{}`, still requires both keys on a chained
`{sourceId} & {runId}`, still rejects a stray key there.

> **The obvious detector for this is inert.** Every fixture in `pane-write-path-types.test.ts` is
> legacy-form, so those directives stay *used* whether or not `Closed<>` landed. Add a **new**
> route-form paramless fixture with `@ts-expect-error openPane(p, { foo: "x" }, …)` in the same
> file, alongside the `Closed<>` change. Without it, nothing proves the fix works.

### 1b. `RouteDef` gains an own-params type parameter

`RoutePaneObject<Params, …> = PaneObject<Params, Params, …>` (`pane.ts:1989-1996`) feeds the **full
chained** params into the **OwnParams** slot. At runtime `useParams()` returns `entry.params`, which
`extractOwnParams` filtered to this pane's own segment names — `MatchEntry.params` is documented
"Own-only" at `pane.ts:404-406`, and the accumulated set lives in the separate `fullParams`.

Live today: `deploymentDetailRoute` has `parent: serverDetailRoute`
(`plugins/apps/plugins/deploy/plugins/deployments/core/routes.ts:15-19`), so
`deploymentDetailPane.useParams()` is typed `{serverId, deploymentId}` and returns
`{deploymentId}`. Latent only because the body destructures one key
(`…/deployments/web/panes.tsx:49`).

Converting `eventSourceRunPane` adds the second instance — and its runs list already reads
`eventSourceRunPane.useRouteEntry()?.params.runId` (`…/runs/web/components/runs-section.tsx:45`),
a seam where the over-typing would immediately offer a `.params.sourceId` that is always
`undefined`. Shipping the headline fix while `useParams()` claims a param it does not return
replaces one lie with another.

**Fix** — carry own-segment params separately:

```ts
export interface RouteDef<
  Params extends Record<string, string> = {},
  Own extends object = Params,          // NOT `extends Record<string, string>`
> { … }

export function defineRoute<Seg extends string, ParentParams extends Record<string, string> = {}>(
  def: { id: string; segment: Seg; parent?: RouteDef<ParentParams, any> },
): RouteDef<ParentParams & RouteParams<Seg>, RouteParams<Seg>>
```

The constraint on `Own` **must be `object`** — with `Record<string, string>`, `RouteParams<Seg>`
fails `TS2344`. This is the one non-obvious byte in the change.

Then thread it: `RouteDefineArgs<Params, Own, …>`, `RouteResolveField<Own>` (own — matching what
`PaneResolveGuard` is actually passed via `pane-box.tsx:86`), `useTitle: (params: Params, …)`
(full — matching `tab-surface.tsx:116`'s `leaf.fullParams`), and
`PaneObject<Closed<Params>, Closed<Own>, …>`.

Blast radius: `RouteDef` is named outside the pane plugin **nowhere**. `RouteDef<any>` becomes
`RouteDef<any, any>` at `pane.ts:1595, 2028` and `route.ts:168, 188-189`.

### 1c. Guard the `usePromote` cross-app crash path

`usePromote`'s cross-app branch builds `route.link(home, params)` where `params` accumulates only
`slots[0..idx]` of the current route (`pane.ts:1748-1752`), and `fillSegment` **throws** on a
missing param. Today that branch is unreachable for legacy panes (`!!route &&`, `pane.ts:1746`).
After conversion, a pane with a paramful ancestor rendered in a foreign app, in a route not
containing that ancestor, hits `Missing param "sourceId"` inside a `useMemo` **during render**.

`deploymentDetailPane` is already exposed; `eventSourceRunPane` joins it. Make the link build
fail into "no cross-app destination" rather than a render crash — the missing param means there is
genuinely no URL to offer, which is the `null` case `usePromote` already models.

---

## Step 2 — Make the facet scanner route-aware, before the sweep

`parsePaneDefinitions`
(`plugins/plugin-meta/plugins/facets/plugins/contributions/facet/internal/static-parse.ts:200-244`)
reads `id` / `segment` **string literals** out of `Pane.define({…})` inside each plugin's `web/`
dir. A route-form pane has neither literal there. The scan feeds `facet/index.ts:70-76` → the
`Pane.Register` static contribution's `paneId`, consumed by the Studio Contributions table and the
plugin-detail card.

**Docs are not affected** — verified. The `Pane.Register "<id>"` doc lines come from the *runtime*
half (`docLabel: (p) => p.pane?.id`, `plugins/primitives/plugins/pane/web/slots.ts:8-11`), which
still works for route panes. So **nothing fails** when the sweep lands: the two Studio surfaces
just go blank for every pane, silently, with no check to catch it. That is why this lands first.

The per-plugin-`web/`-dir shape is structurally wrong under the route form — of the 22 converted
sites, 12 declare their route in the same plugin's `core/`, 7 in a *different* plugin's `core/`,
and 3 in their own `web/`. It is already wrong before routes:
`plugins/apps/plugins/settings/plugins/accounts/web/index.ts:5,12` registers `accountsPane`
imported from `@plugins/auth/web` and gets no `paneId` today.

**Shape — extract locally, join in `relate()`** (where the tree is in scope, exactly as the routes
facet already does at `plugins/plugin-meta/plugins/facets/plugins/routes/facet/index.ts:122-176`):

- *Phase A, `extract()`* — walk `core/`, `shared/`, `web/` for `defineRoute` spans, emitting
  `{ exportName, routeId, segment, parentExportName }`. Keep the existing `Pane.define` walk but
  read the **`route:` identifier** instead of `id`/`segment`, and pair it with `parseImports(src)`
  (`static-parse.ts:27-68`) to emit `{ paneVar, routeLocal, routeModule }`.
- *Phase B, `relate()`* — build a repo-wide `routeId ⇐ (pluginDir, exportName)` index and resolve
  each reference by `@plugins/<path>/<runtime>` specifier or relative path.

Constraints that shape the implementation:

- **A new `const X = defineRoute(` scan is in the class `no-adhoc-binding-scan` bans**
  (`plugins/framework/plugins/tooling/plugins/lint/plugins/marker-scan-safety/lint/`). It must go
  through `markerCallSpans(maskSource(src), "defineRoute")`, reading values back from the original
  by offset.
- **Do not read identity off the imported pane object.** Tempting (`pane._internal.id` is public),
  but the three degraded surfaces all run `skipBarrelImport: true`, so the runtime half is empty
  exactly where it is needed. Record the reason so nobody re-proposes it.
- **Pass `depth0: true` to every `parseStringField`.** The current reader omits it
  (`static-parse.ts:232-234`), so a nested `id:` inside `options:` / `chrome:` would be read as the
  pane id. No site trips it today.
- **Delete `panePath`.** It is read by nothing, and a `RouteDef` knows its whole chain — emit only
  `paneId`, and reintroduce a deliberate full `path` later if a surface wants one.

**Also fix in the same pass** (pre-existing, independent of routes): `rowKey` at
`contributions-facet-table.tsx:68` is `${plugin.id}:${slot}:${id ?? ""}`, passed straight through as
the React `key` and the selection identity. Eight plugins already register **two** route-form panes
from one barrel, so those rows collide — duplicate keys and a selection that always lands on the
first of the pair. Make it unique regardless of whether `paneId` resolves.

---

## Step 3 — Convert all 103 legacy call sites, in one change

### Route placement

**Default: hoist the `defineRoute` immediately above the `Pane.define` it names, in the same
file.** Two live precedents. This is the boundary-safest placement — the `core: ["core"]` runtime
row means promoting one route to `core/` transitively forces **every ancestor route** to `core/`
too, and a `core`-tagged edge is folded into the server and central cycle graphs, not just web
(`plugins/framework/plugins/tooling/plugins/boundaries/boundary-config.ts:24,27`;
`checks/plugins/plugin-boundaries/check/index.ts:377-386`).

Promote to `core/routes.ts` **only** where a server or another plugin must build the link — none
of the 80 need it today.

The 5 cross-plugin parents export their route from the barrel they already export the pane from
(`plugins/auth/web/index.ts:11`, `…/sources/web/index.ts:11`, `…/definitions/web/index.ts:10`) —
a same-plugin re-export, which R2 resolves to the plugin's own origin. Edge count and edge
*strength* both unchanged.

**Never put `export const xRoute = defineRoute({…})` in an `index.ts`** — `isAllowedBarrelStatement`
(`check/index.ts:698-711`) rejects any `export const` in a barrel. No pane sits in a barrel today,
so the hoist is safe as written, but it is a rule the codemod must respect.

### The transform

| legacy | route |
|---|---|
| `id: "x"` | `defineRoute({ id: "x", … })` above |
| `segment: "s/:p"` | `segment: "s/:p"` on the route |
| no `segment` + `appIndex: true` | `segment: ""` on the route, **`appIndex: true` stays on `Pane.define`** |
| `defaultAncestors: [parentPane]` | `parent: parentRoute` |
| everything else | verbatim — `RouteDefineArgs` is field-for-field `DefineArgs` minus the three identity fields |

**Rule, and it is not optional: a pane with no `defaultAncestors` converts to a parentless route.
Full stop.** Inventing a parent "because it reads better" adds a segment to every from-scratch URL
and an extra Miller column. `plugins/apps/plugins/pages/plugins/page-tree/web/panes.tsx:58-63`
already carries this as prose.

Three sites are **not** in a `panes.ts(x)` file — a codemod globbing `**/panes.ts(x)` misses all
three: `…/code/plugins/file-pane/web/file-peek-pane.tsx:28`,
`plugins/conversations/plugins/recover/web/pane.ts:5`,
`plugins/primitives/plugins/css/plugins/layout-harness/web/internal/lab-pane.tsx:6`.

`noUnusedLocals` (`tsconfig.base.json:10`) forces a follow-on edit at the 5 cross-plugin children:
the parent **pane** was imported solely for `defaultAncestors`, so swapping to the route leaves it
unused — a hard error. Three auth wizards import it alone (whole line goes); the runs pane has it
inside a 5-specifier statement (swap one).

### The one intentional URL change

`defaultAncestors` is a **flat, one-level** list — `openPaneImpl` never recurses into an ancestor's
own ancestors (`pane.ts:907-918`). `RouteDef.parentPaneIds` is **transitive** (`route.ts:188-192`).
So a pane whose declared ancestor *itself* declares an ancestor gets a longer from-scratch route.

All 14 edges checked: **exactly one instance.** `eventSourceRunPane`'s from-scratch URL goes
`/events/source/<s>/run/<r>` → `/events/sources/source/<s>/run/<r>`. It is the *right* URL — it
matches what the push path already produces from inside the source detail, and matches the design
note at `…/sources/web/panes.tsx:20-23`. `parseUrl` is ancestry-agnostic, so **old bookmarks keep
parsing**; what changes is only what a from-scratch open produces. Record it in the invariant
allowlist as the single expected delta.

> Second site a converter will be tempted to "fix": `bootProfileDetailPane` is
> `boot-profile/:id` under a parent whose segment is `boot-profile`, so the from-scratch URL is
> already the doubled `/debug/boot-profile/boot-profile/<id>` while its own comment
> (`plugins/debug/plugins/boot-profile/web/panes.tsx:24`) claims otherwise. The mechanical
> transform **preserves** it. Do not fix it here.

### Capability being deleted, deliberately

`defaultAncestors` is an arbitrary array; a route chain is a linear `parent` link. A multi-element
`defaultAncestors` whose members are not a parent chain has **no route-form spelling**. All 14
sites are single-element today, so the migration is possible — but this records the decision
rather than leaving it a silent consequence.

### Test fixtures (23, in 10 files)

Convert alongside the product panes — the overload deletion does not compile otherwise. Contributed
lint rules are off in `**/__tests__/**` by default, so no rule protects them; only `type-check`
does. `pane-write-path-types.test.ts` is a **type-level** test of the write path: with `Closed<>`
in place from Step 1 its four fixtures convert mechanically rather than needing a rewrite.

Add to `plugins/primitives/plugins/pane/core/route.test.ts`: wildcard params, empty
segment / `appIndex`, and a deep (3-level) chain.

---

## Step 4 — Delete the legacy form

In `plugins/primitives/plugins/pane/web/pane.ts`:

- `DefineArgs` (`:1867-1940`), the second overload (`:2006-2018`), the `else` branch (`:2037-2044`)
- `HasParams` (`:67-69`), `ResolveField` (`:71-74`)
- `RoutePaneObject` (`:1989-1996`) — `PaneObject` now always carries `link`
- `link?:` → `link:` (`:1578`); `:1746` collapses to `home.id !== surfaceAppId && canNavigate`;
  `:1840` to `link: (app, params) => route.link(app, params)`

In `plugins/primitives/plugins/pane/core/route.ts`: delete **`InferParams`** (`:23-27`) and its
re-exports (`pane.ts:36`, `core/index.ts:8`) — no consumer outside the pane plugin. `ExtractParams`
survives; it backs `RouteParams`.

In `plugins/primitives/plugins/pane/check/index.ts`: drop the `Pane.define` arm of
`isSegmentDefiningCall` (`:22-35`). It becomes provably dead — `RouteDefineArgs` declares no
`segment` and no `id`, so excess-property checking makes `Pane.define({ route, segment })`
unspellable.

**No ban check or lint rule.** The end state is rung 1: `Pane.define({ id, segment })` stops
typechecking on a missing required `route`. A transitional guardrail would be scaffolding deleted
two commits later, and the repo has no shrinking-allowlist precedent that has not rotted
(`research/2026-06-10-global-lint-allowlist-burndown.md`).

### Prose to update

`plugins/primitives/plugins/pane/CLAUDE.md` — the cross-app-Expand caveat (`:549-551`) becomes
unconditional; `:173` still refers to a `fullPath` that does not exist anywhere in `pane.ts`; the
identity-field guidance (`:538`) drops the `id:` alternative. Also the four `pane.ts` comments that
name the legacy form as a cause (`:1572-1578`, `:1722-1724`, `:1838-1839`, `:2005`), and
`…/runs/web/panes.tsx:32-37`, whose "params are own-only" paragraph becomes false for the chained
half.

---

## Risks

| # | Risk | Detected by |
|---|---|---|
| 1 | **`appIndex` dropped during conversion.** It stays on `Pane.define` while `segment` moves to the route. 10 panes carry it. A drop makes that app's bare root render an empty main area — and it is silent: `appIndex?:` is optional, `pane:segments-unique` skips `""`. (The reverse mistake throws loudly at `pane.ts:2126-2133`.) | The invariant diff must emit a **quadruple** including `appIndex`, not the triple the obvious script writes |
| 2 | **A mis-wired `parent` compiles.** `defineRoute` treats a falsy `parent` as "root" without complaint (`route.ts:189`) and `parent?:` is optional, so a wrong parent yields a *shorter* URL with no diagnostic. The legacy equivalent threw at module eval. | The ancestor invariant diff — which is why it is mandatory, not advisory |
| 3 | **`Closed<>` regression lands undetected.** The existing `@ts-expect-error` directives are legacy-form and stay used either way. | The **new** route-form paramless fixture added in Step 1a |
| 4 | Wide diff conflicts with a concurrent branch touching a `panes.tsx` | A conflict is a 3-line textual one; `pane:segments-unique` plus the missing-`route` type error catch a botched resolution |
| 5 | `usePromote` render crash on a paramful-ancestor pane in a foreign app | Step 1c; it is a `useMemo`-during-render throw, so an error boundary is the fallback, not a caught error |

---

## Verification

**Type-level — the best completeness signal, and it is automatic.** Converting a pane whose
ancestor is paramful widens its required params, so every under-specified call becomes a `tsc`
error. There is exactly one today:
`openPane(eventSourceRunPane, { runId: run.id }, …)` at
`…/runs/web/components/runs-section.tsx:145-150`. It must gain `sourceId` — which the component
already receives as a prop (`SourceRunsSection({ sourceId })`, `:36`). That one-word edit *is* the
headline fix, made visible by the compiler.

**Checks.**

```bash
./equin check          # type-check, pane:segments-unique, eslint, boundary-rules,
                             # plugin-boundaries, plugins-doc-in-sync, format-clean
```

`plugins-doc-in-sync` will legitimately diff — each converted plugin's `Uses:` block moves as
imports change. `boundary-rules` (not `plugin-boundaries`) is the check that would catch a
`core → web` route import, so name it explicitly when reporting.

**Tests.**

```bash
./equin test plugins/primitives/plugins/pane
./equin test plugins/conversations/plugins/pane-restore
```

**URL invariance — the load-bearing proof.** The URL is a pure function of `(own segment of each
slot present, its params)`: `buildRouteUrl` (`pane.ts:524-536`) is the only derivation, `setRoute`
(`:657-685`) the only commit point, and `defaultAncestors` participates in **neither** URL building
nor deep-link reconstruction (its sole runtime read is the from-scratch prepend at `:908`).

Write a one-off invariant script reusing the AST walk already in
`plugins/primitives/plugins/pane/check/index.ts` (`collectSegments`, `:38-68`) over the same
`listCandidateSources` set. Emit per pane `{ paneId, segment, appIndex, ancestorIds[] }` —
resolving `defaultAncestors` **one level** for legacy and walking `parent` **transitively** for
routes. Run before the first conversion and after the last, then diff sorted by `paneId`:

- the multiset of `segment` literals must be **byte-identical**;
- the `(paneId, appIndex, ancestorIds)` set must be identical **except** the one allowlisted entry:
  `event-source-run`, `[event-source-detail]` → `[event-sources, event-source-detail]`.

**Runtime.** Drive the existing sweep at `plugins/primitives/plugins/pane/e2e/surface-match.ts` —
it opens every action-bar item and fails on any page error or crash fallback — as a regression net
over the converted panes. Then the headline defect, three ways:

1. **Before conversion**, add a unit test in `pane/web/__tests__/` registering a legacy fixture
   pair (parent `p/:pid`, child `defaultAncestors: [parent], segment: "ch/:cid"`) against the
   **live** store (the pattern at `history-sink.test.tsx:86-95`), and assert
   `openPane(child, { cid: "c" }, { mode: "root" })` throws `/Missing param "pid"/`.
2. **After**, that call is a *type* error; rewrite the test so
   `openPane(child, { pid: "p", cid: "c" }, { mode: "root" })` produces `/p/p/ch/c`.
3. **E2E**: `eventSourceRunRoute.link(eventsApp, { sourceId, runId })` pasted into a fresh tab —
   pathname survives, run body renders. Note the URL already *parses* today; what conversion buys
   is the ability to **build** it and to open the pane from a route that does not already contain
   the source.

Do not try to reproduce the defect by clicking: the only opener always runs with the source-detail
pane in the route, so `openPaneImpl` takes the inherit-from-existing-slot branch (`:909-912`).

**Deploy.** `./equin build` in the background, then confirm
`~/.singularity/worktrees/<wt>/build-status.json` reads `status: ok` and spot-check the Studio
Contributions table (`http://<worktree>.localhost:9000`) still shows pane ids — the one surface
whose degradation no check would catch.
