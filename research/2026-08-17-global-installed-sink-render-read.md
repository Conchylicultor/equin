# Installed sinks: make the stale render-read impossible to write

## Context

The pane primitive's Expand button asked "is there a cross-app navigator?" from
inside a `useMemo`:

```ts
return useMemo(() => {
  const away = !!route && home.id !== surfaceAppId && canNavigateApp();  // ← module-level read
  …
}, [store, instanceId, slots, surfaceAppId]);
```

`canNavigateApp()` reads a module-level `let` that `TabsProvider` writes in an
**effect** — a commit after the first render. A pane mounting in the same commit
as the provider asked before the answer existed, got "no", and nothing in the
memo's dependency array ever changed, so it kept that answer for the pane's
whole life.

The failure was invisible and mount-order dependent. The page-detail pane loads
in the deferred plugin tier and happened to mount *after* the effect, so it
worked and its tests passed; the conversation pane was silently broken in every
foreign app. It surfaced only by driving a second pane by hand.

That one site is fixed (`app-nav-sink` grew subscribers and a
`useCanNavigateApp()` hook). **Nothing prevents the next instance** — the pane's
own `getHistoryAdapter()` and every other imperative module singleton read from
a render path has the same failure mode available to it, and a hand-rolled sink
does not even have to have a hook to subscribe to.

## The class of bug, precisely

An **installed sink** is a module-level slot that a *higher* layer installs an
implementation into and a *lower* layer calls — the codebase's answer to "tabs
imports pane, so pane cannot import tabs". `HistoryAdapter`, the cross-app
navigator, the overlay-boundary fallback and the live-store pointer are all this
shape.

Three properties conspire:

1. **Installation is late.** It happens at provider mount, i.e. in an effect —
   one commit after the first render of everything mounted alongside it.
2. **A render-path read is a one-shot sample.** `useMemo`, a `useState`
   initializer, or a bare call in a component body all capture the value once;
   the sink is not in any dependency array, so nothing re-runs.
3. **Whichever answer you get is mount-order luck.** Eager vs deferred plugin
   tiers decide it, so one consumer works and its neighbour does not.

The correct read from a render path is always a **subscription**; the imperative
read is correct only from an event handler or an effect, where it runs after
installation and re-runs on every invocation.

## Why the fix is a primitive + a naming convention + a lint rule

Walking the structural-fix ladder in `CLAUDE.md`:

- **Rung 1 (inexpressible)** buys the *presence* question outright. If the only
  presence API a sink exposes is a hook (`useInstalled()`), "is anything
  installed?" cannot be answered non-reactively in render — the exact question
  that produced this bug has no wrong spelling left.
- **Rung 2 (type error)** cannot express "this function may not be called during
  React render" — there is no token a non-render context could carry.
- **Rung 3 (check/lint)** is where the remaining half lands: the imperative
  sample is *legitimate* from an event handler and *wrong* from render, which is
  a call-context invariant across files. That is exactly what rung 3 is for.

Rung 3 is only decidable if the lint rule can *recognise* an imperative sample
at an arbitrary call site. Today it cannot: `canNavigateApp()` and
`getHistoryAdapter()` are free functions indistinguishable from `getUserName()`.
So the primitive's real job is to give every sample **one shape and one name**:
`sink.peek()`. After that the rule is three lines of AST.

## Design

### New plugin: `plugins/primitives/plugins/install-sink`

A leaf (imports `react` only, plus the `PluginDefinition` type), sitting beside
`edit-mode-signal` / `latest-ref` / `report-sink` as a sanctioned home for an
idiom. `defineReportSink` is its write-side twin (a slot you *emit into*); this
is the read-side (a slot you *call*).

```ts
// pane/web/app-nav-sink.ts — the declaration, at module scope
export const appNavSink = defineInstallSink<AppNavigator>({
  name: "pane.app-nav",
  what: "the cross-app navigator (installed by apps-core/tabs at provider mount)",
});

// apps-core/tabs — the install, in the provider's effect
useEffect(() => appNavSink.install(navigate), [navigate]);

// a render path — subscribed, so a late install re-renders
const canNavigate = appNavSink.useInstalled();

// an event path — sampled at click time, after installation
onClick={() => appNavSink.peekOrThrow()(url, opts)}
```

API:

| Member | Returns | Use from |
|---|---|---|
| `install(value)` | `() => void` (restores the **previous** occupant) | effect / boot |
| `useInstalled()` | `boolean`, subscribed | render |
| `useValue()` | `T \| null`, subscribed | render |
| `peek()` | `T \| null`, one-shot | event / effect only |
| `peekOrThrow()` | `T`, throws naming the sink | event / effect only |

A sink declared with a `fallback` (the history adapter's standalone default) is
never absent: `useValue()`/`peek()` return `T`, and `useInstalled()`/
`peekOrThrow()` do not exist on it. Two overloads, one implementation.

`install()` returning a **restore-the-previous disposer** replaces today's
hand-written `return () => setHistoryAdapter(defaultHistoryAdapter)`, which is a
teardown that has to remember what the default was.

The one module-level `let` in the repo-wide idiom now lives inside the primitive,
carrying the single `scoped-store/no-module-mutable-store` disable for the whole
family, exactly as `scoped-store` owns the per-surface half.

### Rule 1 — `install-sink/no-render-phase-peek`

Bans a call named `peek…` (member call `x.peek()`, `x.peekOrThrow()`, or a bare
`peekFoo()`) that executes **during render**.

Render-phase detection: from the call, walk out to the enclosing component
(`/^[A-Z]/`) or hook (`/^use[A-Z]/`). If every function boundary crossed is one
that React invokes *during* render, it is a violation. Render-time boundaries are
a closed whitelist — an IIFE, `useMemo`'s callback, `useState`'s initializer,
`useReducer`'s third argument, and the callback of an inline array method
(`map`/`filter`/…). Every other boundary (an effect callback, a `useCallback`, a
returned closure, an `onClick` prop) is deferred, and the walk stops there with
no report. Zero boundaries — a bare call in a component body — is a violation.

The whitelist direction matters: an unrecognised boundary is treated as deferred,
so the rule has **no false positives** (it runs as `error` repo-wide) at the
price of missing exotic render-time callbacks.

Message: name the hook to use instead.

### Rule 2 — `install-sink/no-laundered-peek`

`canNavigateApp()` was not written as a peek at its call site; it was a getter
that *wrapped* one. A wrapper defeats rule 1 in one hop, and it is how the
original bug was actually spelled.

So: an exported module-scope function whose **returned expression is a peek**
(the call itself, or a null/undefined comparison or `!`/`!!` of it) must either
be named `peek…` or be a hook. Deliberately tight — a function that *acts* on a
peeked value (`navigateApp(url)` → `void`) is not laundering and is not flagged.

### Rule 3 — `install-sink/no-adhoc-install-sink`

Catches the sink that never reaches the primitive: a module-scope `let` written
by an exported `set*`/`install*`/`register*` function and read by another
function in the same file. Message points at `defineInstallSink`. Same
disable-with-a-reason escape hatch as `no-module-mutable-store`, whose message
also gains a pointer here so a hand-rolled sink lands in the right home whichever
rule catches it first.

### What is deliberately NOT in scope

- **Page-global signals** (`edit-mode-signal`, `focused-surface`, `focusedApp`)
  are a different concept — a value that changes over time, not an implementation
  installed once — and they already expose subscribing hooks. They benefit from
  the same `peek…` naming and rule 1 covers them the moment they adopt it; a
  follow-up task sweeps them.
- **`web-sdk/core/deferred-load-store`** cannot import a `primitives/` plugin
  (the barrel's `PluginDefinition` type import would close a cycle). It keeps its
  hand-rolled shape with a disable.
- **A runtime "am I rendering?" assert.** There is no supported React API for it;
  the only implementations poke `__CLIENT_INTERNALS…`, which this repo does not
  do anywhere today. Rejected as a hack.

## The audit: two live instances, same shape

A repo-wide sweep of module-level sinks (installer + imperative getter) and their
call sites found the class alive in one more place — `apps-core/tabs`'s
**placement registry**, which ships *two parallel read APIs for the same sink*: a
reactive one (`usePlacementCapabilities` / `useDefaultPlacement`) and three plain
functions (`getDefaultPlacement`, `placementIsNewTabFollows`,
`placementHasAppThemeScope`) that read the module variable directly. The plain
ones are being called from render:

1. **The tab bar's `+` button.** `app-tab-bar.tsx` calls
   `placementIsNewTabFollows(mode)` in the component body. The registry is
   installed by `SurfaceBody`'s effect, in a different subtree, and the tab bar
   subscribes to nothing that changes when it lands.
2. **The page's chrome theme.** `useRootThemeScope()` reads `mode` reactively but
   asks `placementHasAppThemeScope(mode)` non-reactively. Its consumers are the
   rail, the tab bar, the toaster and — via `ThemeInjector` — the `:root` token
   layer for the whole page. Mounted in the first commit, it can compute "no app
   theme scope" before the registry exists and never re-derive.

A third (`getDefaultPlacement()` inside a `useState` initializer in
`use-tabs.tsx`) is currently harmless only because `TabsProvider` re-derives the
mode reactively on every render — a fragile accident, not a design.

Everything else checked out: `getHistoryAdapter`, `getEditMode`,
`getSurfaceMode`, `getFocusedSurfaceId`, the floating-window getters and the
deferred-load getters are all read from event handlers, effects or non-React
paths only. `canNavigateApp()` has no callers left at all.

The placement fix is the same one the ladder points at everywhere else: the
predicates stop reaching for the sink and take the capabilities value as an
argument, so a render path can only obtain it from the hook.

## Work

1. **New plugin** `plugins/primitives/plugins/install-sink/`
   — `web/internal/define-install-sink.ts` (the factory), `web/index.ts`,
   `package.json`, `CLAUDE.md`, `lint/index.ts` + the three rule files and their
   `RuleTester` suites (bun:test, beside the rules — see
   `scoped-store/lint/no-module-mutable-store.test.ts` for the harness).
2. **Migrate the pane's three sinks** —
   `pane/web/history-sink.ts` (`activeAdapter` + the `getLiveStore` accessor),
   `pane/web/app-nav-sink.ts` (deletes its hand-rolled subscriber set), and the
   `liveStore` pointer in `pane/web/pane.ts`. `apps-core/tabs/web/internal/
   use-tabs.tsx` installs through the returned disposers.
3. **Migrate `primitives/overlay-boundary`**'s `registerOverlayFallback`.
4. **Fix the placement registry** — migrate it to the primitive, turn
   `placementIsNewTabFollows` / `placementHasAppThemeScope` /
   `getDefaultPlacement` into pure functions of the capabilities value, and give
   `app-tab-bar.tsx`, `use-chrome-theme-scope.ts` and `use-tabs.tsx` the value
   through `usePlacementCapabilities()` instead of the module read.
5. **Point `no-module-mutable-store`'s message** at the new primitive.
6. **Docs** — the new plugin's `CLAUDE.md`; the pane `CLAUDE.md` section on the
   sink seam rewritten to name the primitive rather than re-explain the hazard.

## Verification

- `./equin check` (type-check + eslint over the new rules, plugin
  boundaries, doc sync, registry sync).
- `./equin test plugins/primitives/plugins/install-sink` — the rule suites.
- `./equin test plugins/primitives/plugins/pane` +
  `plugins/apps-core/plugins/tabs` — the existing history/isolation suites are
  the regression net for the migration.
- `./equin build`, then drive the real app: open a conversation pane inside
  a foreign app (`/pages/…` hosting a conversation) and confirm Expand appears on
  the *first* paint — the original symptom — via the e2e screenshot harness.
