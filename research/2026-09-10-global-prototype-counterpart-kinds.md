# Prototype counterparts: tagged `mocks` declaration, open kind registry, chromeless embed

## Context

The Prototypes app's detail pane has a **Component** stage that puts a prototype
mock beside the real app component it mocks. The pairing is declared in the
prototype's own `index.html` as `<meta name="mocks" content="<fixture id>">`, a
bare layout-harness fixture id. That works for a widget but cannot grow to a
whole screen: a fixture is a real component with hand-written props and no
routing, live data or pane chrome, so a fixture of a full app would be a second
implementation that drifts from the real one. Drift is the very thing the
side-by-side exists to catch, so the reference for a screen must be the running
app itself.

The goal (humans and agents comparing mock vs real, side by side, to spot and
correct differences) needs the declaration to say **what kind of thing** it
mocks, and the set of kinds to be open so a new way of showing a counterpart is
a new plugin folder.

Decisions already taken by the owner:

- The declaration is a **tagged value in `content`**:
  `<meta name="mocks" content="fixture:control-panel/setting-rail" />` or
  `content="route:/agents/c/123"`.
- Kinds are contributed through a **slot**; the display options are extensible.
- The detail pane's **Compare** stage becomes the mock-vs-counterpart view. The
  old Compare stage (a scrolling row of every prototype) is **removed**; the
  Component stage is subsumed.
- The `route:` kind frames the real app **chromeless now** (no app rail, no tab
  bar), which means adding an embed mode to the app shell.

## Design

### 1. `primitives/embed` — the declared chromeless signal (new leaf plugin)

`plugins/primitives/plugins/embed/` with `core/` (pure, tested) and `web/`.

- `core`: `EMBED_PARAM = "embed"`, `EMBED_VALUE = "1"`, `hasEmbedFlag(search)`,
  `withEmbedFlag(rawUrl, origin)` (goes through `new URL`, so a path that
  already carries a query gets `&embed=1` and a duplicate flag is overwritten,
  not appended). `core/embed.test.ts` covers those.
- `web`: `isEmbeddedDocument()` reads `window.location.search` **once** and
  memoizes for the document's lifetime; `embedUrl(path)`; `resetEmbedForTests()`.

  Why read-once: the pane store rebuilds every URL it writes from the route
  alone (`buildRouteUrl` + `applyBasePath` in
  `plugins/primitives/plugins/pane/web/pane.ts`), so no query survives the
  first in-frame click. The flag is a fact about how this document was opened,
  so that is what is captured. Additionally, `commit()` in
  `plugins/apps-core/plugins/tabs/web/internal/shell-history-adapter.ts` (the one
  sanctioned `window.history` writer) re-stamps the flag via `embedUrl` when
  embedded, so a frame reload after in-frame navigation still comes back
  chromeless.

Why a query flag and not a `Surface.Placement` mode: the rail and the tab bar
live outside the surface, so a placement cannot remove them. Why not a
`window.self !== window.top` heuristic: the browser app and the page embed
block also frame things, and a heuristic is not a declaration.

Why under `primitives/`: one reader is `primitives/scope/app-instance`, which
may not import apps-core. It is a sibling of `scope`, not a child: `scope`
answers "which mounted instance", this answers "how is this document presented".

**Four readers, each a one-line branch on an existing path:**

| File | Change |
| --- | --- |
| `plugins/apps-core/plugins/layout/web/components/apps-layout.tsx` | `TabBarHost` returns null when embedded; `FramedSurface` uses the existing `RaillessFraming` instead of the `Apps.RailFraming` contribution. Zero edits to `tab-bar/` or `app-rail-framing/`. |
| `plugins/shell/plugins/global-action-bar/web/components/global-action-bar.tsx` | `FloatingActionBarHost` returns null when embedded. The docked host lives in the tab bar, which is gone. |
| `plugins/primitives/plugins/scope/plugins/app-instance/web/internal/app-instance.ts` | `resolveInstanceId()`: when embedded, mint a fresh id and return **before** `commitRegistry`. |
| `plugins/apps-core/plugins/tabs/web/internal/tabs-store.ts` | `savePersistedTabs()` no-ops and `loadPersistedTabs()` returns null when embedded. Boot then seeds one tab from the URL and the placement mode falls to the registry default (docked), so a host in floating mode never opens the frame onto a wallpapered desktop. |

The last two are a **hazard guard**, not polish: a same-origin iframe shares the
host tab's `sessionStorage`. Without them the framed document would append a
generation to the host's `singularity.appInstances` registry and, at
`RETAINED_INSTANCES = 8`, evict and sweep the user's real `app-tabs:` payloads
just by remounting a few times (every `src` change remounts the frame).

Deliberately still rendered when embedded: the toaster and the headless
crash/report collectors. An embed flag that swallowed error surfaces would be
worse than one that shows a toast. Say so in the plugin's `CLAUDE.md`.

### 2. `files/core/mocks.ts` — the declaration, parsed

```ts
export type MocksDeclaration =
  | { kind: "none" }
  | { kind: "malformed"; raw: string; reason: string }
  | { kind: "declared"; tag: string; ref: string };

export function parseMocks(raw: string): MocksDeclaration;
export function mocksProblemDetail(d: Extract<MocksDeclaration, { kind: "malformed" }>): string;
```

Rules, in order: trimmed-empty → `none`. Split at the **first** colon
(`indexOf`, so a ref may contain colons). No colon → malformed, "there is no
`<kind>:` prefix". Empty tag → "the kind before the colon is empty". Empty ref
→ "there is nothing after the colon". Tag not matching `^[a-z][a-z0-9-]*$` →
"a kind is lowercase letters, digits and dashes". Else `declared`.

Syntax only. The kind set is open (contributed on the web), so `files/core`
cannot judge whether `tag` names a kind anybody handles; that is a rendering the
compare surface owns. Three arms, not two: collapsing `malformed` into `none`
would make the Compare stage say "declares no counterpart" about a line the
author just mistyped.

- `files/core/prototypes.ts`: `mocks: z.string()` becomes a
  `z.discriminatedUnion("kind", …)` mirroring the type; rewrite the doc comment.
- `files/shared/list-metas.ts`: `HtmlMeta.mocks` is a `MocksDeclaration`,
  `base.mocks = { kind: "none" }`, `parseHtmlMeta` returns
  `parseMocks((mocksRaw ?? "").trim())`.
- `files/core/validate.ts` (`validatePrototypeFolder`): a third `HTMLRewriter`
  pass reads the tag and pushes a `problems[]` entry with `mocksProblemDetail`
  when malformed. Absent stays not-a-problem. This surfaces on the gallery card
  and the Focus banner, and also runs in `./equin check
  prototypes:self-contained` over the repo template.
- `files/core/mocks.test.ts` (next to source, pure runner): empty/whitespace;
  `fixture:control-panel/setting-rail`; `route:/agents`; `route:/agents?tab=x`;
  `a:b:c` (ref keeps the second colon); the bare legacy form `control-panel/…`
  → malformed; `:x`; `x:`; `Fixture:x`; whitespace around both halves.

Consumers of `meta.mocks` today are exactly three: the schema, `list-metas.ts`,
and `compare-component`'s stage (dissolved below).

### 3. `prototypes/plugins/compare` — the stage, the kind slot, the chrome

```
plugins/apps/plugins/prototypes/plugins/compare/
├── package.json, CLAUDE.md
├── web/index.ts            # PrototypeStages.Stage "compare" (order 20); slots: Counterpart
├── web/slots.ts            # Counterpart.Kind + types
├── web/components/
│   ├── compare-stage.tsx   # parse → none | malformed | <Counterpart.Kind.Dispatch>
│   ├── counterpart-stage.tsx  # THE chrome: one width control, both halves
│   ├── mock-frame.tsx      # moved verbatim from compare-component
│   ├── unknown-kind.tsx    # the Dispatch fallback
│   └── notices.tsx         # NoDeclaration / MalformedDeclaration copy
└── plugins/
    ├── fixture/            # git mv of compare-component → kind "fixture"
    └── route/              # new → kind "route"
```

**The contract: a resolver component with a children callback.** A kind
contributes a real component (so it may run hooks and mounts inside the
dispatch middleware's boundary) whose only output is `children(resolution)`.
It cannot paint layout, so the shared-width invariant lives in one place.

```ts
export type WidthChoices = readonly [number, ...number[]];

export type CounterpartResolution =
  | { status: "loading"; label?: string }
  | { status: "unresolved"; title: ReactNode; detail: ReactNode }
  | {
      status: "found";
      widths: WidthChoices;              // the widths THIS counterpart can speak to
      title: string;                     // heading over the counterpart half
      subtitle?: string;                 // caption (fixture dims / resolved route)
      badge?: string;                    // identifier chip in the header
      render: (width: number) => ReactNode; // called inside a PluginErrorBoundary
    };

export interface CounterpartKindProps {
  kind: string;      // the tag — the dispatch key
  target: string;    // everything after the first colon (not `ref`: collides with RefAttributes)
  meta: PrototypeMeta;
  version: number;
  children: (resolution: CounterpartResolution) => ReactNode;
}

export interface CounterpartKindMeta {
  label: string;     // "App component" / "App screen"
  example: string;   // a COMPLETE content value, e.g. "fixture:control-panel/setting-rail"
}

export const Counterpart = {
  Kind: defineDispatchSlot<CounterpartKindProps, string, CounterpartKindMeta>({
    key: (p) => p.kind,
    fallback: UnknownKind,
    docLabel: (c) => c.label,
  }),
};
```

`defineDispatchSlot` (from `@plugins/primitives/plugins/slot-render/web`)
already gives exact-string `match`, a `fallback` for "nothing handles this
kind", extra typed fields, and is not reorderable, so it owes no config
override. Contributors register `Counterpart.Kind({ match: "fixture", label,
example, component })`.

`CompareStage` reads `meta.mocks`: `none` → `NoDeclaration` (lists every
registered kind's `example` from `Counterpart.Kind.useContributions()`, so the
syntax shown is the registry's); `malformed` → `MalformedDeclaration` (quotes
the raw value and the reason); `declared` → `<Counterpart.Kind.Dispatch kind
target meta version>{(r) => <CounterpartStage …/>}</…>`.

`CounterpartStage` renders the mock half (`MockFrame`, plain iframe at the
chosen width, height `meta.viewport.h`) in **every** arm, since the mock is known
immediately. The counterpart half per arm: `loading` → `<Loading/>`,
`unresolved` → the notice, `found` → `<PluginErrorBoundary>` around
`render(width)`. Width state lives here: one `SegmentedControl` over
`resolution.widths` (hidden when there is one choice), default = the offered
width closest to `meta.viewport.w`, picked width validated against the list.
`defaultWidth`, `Half`, and the header bar move here from `component-stage.tsx`.

The `UnknownKind` fallback calls `children({ status: "unresolved", … })` naming
the tag and the known kinds, so the four states are visibly distinct:

| State | Decided by | Copy |
| --- | --- | --- |
| no tag | parser | "declares no counterpart" + every kind's example |
| malformed | parser (+ `problems[]` on Focus) | raw value + reason |
| unknown kind | Dispatch fallback | "nothing here shows a `<tag>:` counterpart" + known kinds |
| unresolvable ref | the kind | fixture: missing / region; route: no app / no pane |

Gallery: delete `web/components/compare-stage.tsx` and its contribution; keep
Focus. Keep `PrototypeStageProps.gallery` (the stage set is an open slot and the
list is already resolved by the pane), with a doc-comment line saying it is
offered, not required.

### 4. `compare/plugins/fixture` (moved from `compare-component`)

`git mv` for history. `FixtureCounterpart` keeps the catalog load
(`loadFixtures()` in an effect, once) and maps its three states one-to-one:
catalog null → `loading`; missing or region fixture → `unresolved` with the
existing copy; found → `found` with `widthChoices(fixture)` (fallback
`360/640/960`), title "App component", subtitle `dimsLabel`, badge the id,
`render: () => fixture.render()`. Its `CLAUDE.md` keeps the runtime-lookup,
region-fixture, and why-not-`ScaledIframe` prose; the shared-width prose moves
to the parent.

### 5. `compare/plugins/route` (new)

`RouteCounterpart`, synchronous (never `loading`):

1. `target` must start with `/` → else `unresolved` "a route is an in-app path".
2. `resolveAppForPath(target, Apps.App.useContributions())` from
   `@plugins/apps-core/web` → none → "No app in this worktree owns `<target>`."
3. `parseUrl(resolved.routePath)` from `@plugins/primitives/plugins/pane/web`
   (takes the app-local path) → `unresolved` → "`<app>` owns that prefix, but
   this worktree has no pane at `<target>`."
4. `found`: widths = `[480, 768, 1024, 1280, 1600]` merged with
   `meta.viewport.w`, deduped, ascending (the declared width is always offered
   and is the default); title "App screen"; subtitle the resolved app + route;
   badge the target; `render` = an iframe with `src={embedUrl(target)}`, width
   100% of the half, height `meta.viewport.h`, **no `sandbox` attribute**, and
   **no `?v=` cache-bust**.

Why no `sandbox`: on a same-origin frame `allow-same-origin` makes it a no-op
as a boundary, while it silently withholds modals, popups, downloads and forms,
so a route that opens a picker breaks only inside the Compare stage. Storage,
`BroadcastChannel` and Web Locks are origin-keyed, so live-state's cross-tab
election (`primitives/networking/web/cross-tab-election.ts`) treats the frame as
one more document either way. Why no `?v=`: the counterpart is the live app, and
a prototype edit must not reboot it.

Self-framing is safe: the picked stage is React state in
`PrototypeDetailProvider`, never persisted and never in the URL, so a framed
`/prototypes/proto/<same>` opens on Focus and recursion stops at depth one. Note
this in the route `CLAUDE.md` since persisting the pick would silently break it.

Cost to state plainly: the frame boots a second copy of the SPA once; width
changes are CSS and do not remount it.

### 6. Docs and host-global files

- `prototypes/CLAUDE.md` "four metadata tags": new `<kind>:<ref>` syntax, both
  examples, kinds are open and the Compare stage lists what this worktree knows,
  a value with no prefix is reported as a problem.
- `prototypes/_template/index.html` (repo): the commented-out example line
  becomes `fixture:control-panel/setting-rail` and the comment mentions `route:`.
  It sits inside an HTML comment, so it is not parsed and the self-contained
  check does not depend on it.
- New `CLAUDE.md` for `compare`, `compare/plugins/route`, `primitives/embed`;
  adapted for `compare/plugins/fixture`; trimmed for `gallery` (Focus only) and
  `files` (the `mocks` section); `prototypes/CLAUDE.md` sub-plugin list.
- Plugin `description` strings: `gallery`, prototypes `shell` (says
  "Focus/Compare detail panes"), the three compare plugins, `embed`.
- **Host-global, hand-edited at implementation time, not in git:**
  `~/.singularity/apps/prototypes/_template/index.html` (the seed is
  never-overwrite and mints copy this one) and
  `~/.singularity/apps/prototypes/proto-1788886679-mpxw/index.html` (the one
  prototype using the bare form; until fixed it shows a problem badge, which is
  the migration working).

### 7. Build and checks

- Each new plugin dir gets a `package.json` (copy `compare-component`'s, rename:
  `@singularity/plugin-apps-prototypes-compare`, `-compare-fixture`,
  `-compare-route`, `@singularity/plugin-primitives-embed`).
- `compare/web/index.ts` declares `slots: Counterpart` or the build fails.
- `./equin build` regenerates registries, autogen doc blocks and
  `docs/plugins-*.md` (seven primitives' reverse indexes mention
  `compare-component`; all regenerated).
- `reorderable-slots.generated.ts`: no impact (dispatch slot is not reorderable;
  the stage slot is a plain `defineSlot`).
- `config/apps/prototypes/gallery/prototypes-detail.actions.jsonc` pins the
  switcher's contribution id, not stage ids: unaffected.
- No e2e script or check keys on the "Component"/"Compare" labels.

## Step order

1. `primitives/embed` + test.
2. The four embed readers, plus the history-adapter re-stamp. Verifiable alone
   with a `?embed=1` screenshot.
3. `files/core/mocks.ts` + test, schema union, `validate.ts` problem,
   `list-metas.ts`.
4. `compare` plugin: slots, stage, chrome, notices, fallback (no kinds yet; the
   stage renders "unknown kind" for everything, a real checkable state).
5. `git mv compare-component → compare/plugins/fixture`; rewrite as a resolver.
6. `compare/plugins/route`; delete the gallery's compare stage.
7. Docs; the two host-global hand edits; the repo template comment.

## Verification

```bash
./equin build      # run_in_background: true, then end the turn

# Embed mode on its own: no rail, no tab bar, no floating action bar; then the control.
./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --path '/agents?embed=1' --out /tmp/embed
./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --path '/agents' --out /tmp/chrome

# The Compare stage per kind (one prototype tagged fixture:…, one route:/agents).
./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --path /prototypes/proto/<id> --click "Compare" --viewport 1600x1000 --out /tmp/compare

./equin test plugins/apps/plugins/prototypes
./equin test plugins/primitives/plugins/embed
./equin check plugin-boundaries
./equin check           # doc + registry in sync, prototypes:self-contained
```

By hand, since no check covers it: note the host's open tabs, open a prototype
with a `route:` counterpart, flip widths several times, reload the host tab. The
tab set must be unchanged. That is the sessionStorage guard working, and the one
failure here that would otherwise be silent.

## Follow-ups (out of scope)

- Agent path: a script that takes a prototype and its declared counterpart and
  emits both screenshots at the same width, then a measured-gap table.
- Region fixtures as counterparts (needs the harness's region children).
