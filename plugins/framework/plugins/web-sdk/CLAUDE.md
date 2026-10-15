# Plugin Core

Framework for Singularity's plugin system. Every feature is a plugin — including the app shell.

## Concepts

There are only two primitives: **slots** and **contributions**.

- A **slot** is a typed extension point defined by a plugin. It declares the shape of data it accepts.
- A **contribution** is an entry a plugin provides to another plugin's slot.

Plugins never import from each other's internals. They only import **slot definitions** (which are lightweight typed factories).

## Sharing code between web and server

The rule is in the root `CLAUDE.md` → "Collection-consumer separation": a **closed list** both runtimes need is plain data in the plugin's `core/`; a **genuinely open, runtime-collected set** is a slot. Rule of thumb: *if you can write the whole list in one array today, it's `core/`; if a future plugin must add to it without editing your code, it's a slot.*

A slot lives in one runtime, so bridging its contributions to the other runtime costs a generated registry plus a `*-in-sync` check. Don't pay that for a set you can enumerate today — that's an asymmetry you create, then have to patch.

## How It Works

### Defining a slot

`defineSlot<P>(id)` (from `@plugins/framework/plugins/web-sdk/core`) returns an object that is both:

1. **A factory** — call it with props to create a contribution: `MySlot({ title: "Hello", component: Hello })`
2. **A hook** — `.useContributions()` inside React returns all contributions targeting this slot

Slots are grouped in a namespace object per plugin (`export const MyPlugin = { Panel: … }`) — see the `defineRenderSlot` example below, which has the same shape.

### Declaring the slots you own

A plugin declares the slots it owns in `slots`, the sibling of `contributions`.
It is a **record, never an array** — the KEY is what names the slot, because a
slot's id is `` `${pluginId}.${key}` ``:

```typescript
export default {
  description: "…",
  slots: MyPlugin,                    // a slot group: its own keys are the names
  contributions: [ … ],
} satisfies PluginDefinition;

export default {
  description: "…",
  slots: { canvas: canvasPane },      // a lone slot/pane needs a key to name it
  contributions: [ … ],
} satisfies PluginDefinition;
```

A value is **a slot, or an object whose own values are slots** — a slot group, a
pane (its `Actions` slot). Values are read **one level deep**; a slot nested
deeper is declared on its own key.

`slots: [MyPlugin]` is the old form and does not work: an array is an object, so
its key path would be `"0.sidebar"` — an id nobody wrote. `collectSlots` throws
naming the fix, but `SlotRecord` is `object`, so `tsc` does not catch it first
(see task-1787890773432-i2biih).

This is not bookkeeping. It is what makes a slot **discoverable** (the docs and
the reorder manifest read the declaration, not an export-graph crawl that
depended on which symbols a barrel happened to re-export) and what makes it
**attributable** — the declaring plugin is the slot's owner, which is where its
reorder config file lands. Two plugins declaring one slot is an error.

You cannot forget it: every slot is recorded at construction (`defineSlot` is
the single funnel), and `./singularity build` fails naming any slot no plugin
declared, plus the directory whose source constructed it.

`defineSlot` also stamps `slot.meta` — `{ kind, reorderable }` — so what a slot
IS is a fact on the object rather than something a reader re-derives by sniffing
which render method got attached or by grepping for a constructor's name.

### Creating a plugin

A plugin is a `PluginDefinition` — just `{ description, contributions? }`. There is no authored `name`: the loader derives the plugin's `id` from its hierarchy path and injects it as `LoadedPlugin.id`. User-facing titles belong to the contributions (an app's tooltip, a sidebar entry's title), not the plugin package.

```typescript
import { type PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Shell } from "@plugins/shell/web";

export default {
  description: "My plugin, in one line.",
  contributions: [
    Shell.Sidebar({ title: "My Panel", icon: MyIcon, component: MyPanel }),
  ],
} satisfies PluginDefinition;
```

### Rendering contributions

**Invariant:** `useContributions()` returns a sealed list — `component` is an opaque
`SealedComponent` that **cannot be rendered directly** (`<c.component/>` is a compile
error); every other field (`id`, `order`, `title`, `icon`, `match`, `.length`) is readable.
Rendering goes through one of the primitives below, which apply the error-boundary /
reorder middleware chain so one broken contribution never crashes the whole surface.

#### `<Slot.Render/>` — render all contributions (use `defineRenderSlot`)

```typescript
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";

export const MyPlugin = {
  Panel: defineRenderSlot<{ title: string; component: ComponentType }>("myplugin.panel"),
};

// render site — auto-renders every contribution, each isolated
<MyPlugin.Panel.Render />

// or inject extra props via children callback (receives the real, unsealed component)
<MyPlugin.Panel.Render>
  {(item) => <item.component title={item.title} extraProp="x" />}
</MyPlugin.Panel.Render>
```

**Every `defineRenderSlot` is reorderable, so it owes a reviewed config override.** One
build plus one edit — you never author the file, locate an origin, or type a hash:

1. write the `defineRenderSlot`
2. `./singularity build` → seeds `config/<defining-plugin>/<slotId>.jsonc` (real `// @hash`,
   full catalog, a `// @review` marker), then fails `config:overrides-authored` on the marker
3. arrange `"items"` for how the slot renders, DELETE the `// @review` line
4. `./singularity build`

That file is also where a slot's items are **positioned**: a `{ "type": "spacer", "id": "…" }`
node pushes every item after it to the far end of the row. Splitting one row across two
slots to right-align some items is the wrong tool (`spacer/no-split-slot-row` flags it) —
the node forms are listed in the `// @legend` block the build keeps at the top of the file.

`./singularity check reorderable-slots-in-sync` names the exact override path a new slot
will owe, before any build. If the order should never be user-curated the slot is headless —
use `defineMountSlot`, which is not reorderable and owes nothing. Details:
[`plugins/reorder/authoring-overrides.md`](../../../reorder/authoring-overrides.md).

#### `<Slot.Dispatch {...props}/>` — single match (use `defineDispatchSlot`)

Selects **one** contribution whose `match` satisfies the props, renders it isolated.
`match` may be a `string` (exact), `RegExp`, or `(props) => boolean` predicate.
Precedence: exact → RegExp → predicate (registration order within each tier).

```typescript
import { defineDispatchSlot } from "@plugins/primitives/plugins/slot-render/web";

// slot definition — key derives the dispatch key from props
export const Editor = {
  Block: defineDispatchSlot<BlockProps, string>("editor.block", {
    key: (props) => props.block.type,
    fallback: UnknownBlock,
  }),
};

// contributor — must provide match so Dispatch can select it
Editor.Block({ match: "text", component: TextBlock });

// render site
function BlockRow(props: BlockProps) {
  return <Editor.Block.Dispatch {...props} />;
}
```

`.Dispatch` publishes whether it matched or fell through to `fallback`; a descendant reads
`useDispatchOutcome()` (same barrel) → `{ slotId, key, matched } | null` for the **nearest**
enclosing `.Dispatch`. That is the sanctioned way to react to "nothing handled this". Do
**not** hand-thread an `isFallback`/`trailing=` prop through each fallback component — it
has to be re-wired for every one, and every new fallback starts out missing it. Contract:
[`slot-render/CLAUDE.md`](../../../primitives/plugins/slot-render/CLAUDE.md).

#### `renderIsolated()` — bespoke selection, still isolated

For cases where neither `.Render` nor `.Dispatch` can express the selection logic
(e.g. tiered `supports()` checks).

```typescript
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";

const contributions = FilePane.Renderer.useContributions();
const match = contributions.find((c) => supportsFile(c, file));
if (match) return renderIsolated(FilePane.Renderer.id, match, { file });
```

#### `UNSAFE_unsealSlotComponent()` — framework exemptions only

Returns a raw, **non-isolated** `ComponentType`. Reserved for the few sites that
structurally cannot route through the middleware chain: `Core.Root` in `web-core/web/App.tsx`
(web-sdk cannot import slot-render; already hand-wrapped in `<PluginErrorBoundary>`),
`ErrorBoundary.Action` (renders inside the boundary's own fallback), and `active-data`'s tag
components (spliced into a foreign ReactNode tree, not a flat slot list). Every call must
carry a `// UNSAFE: <reason>` comment. Import from `@plugins/framework/plugins/web-sdk/core`.

### Registering a plugin

Nothing to register by hand (root `CLAUDE.md` → "Registry exclusivity"). `./singularity
build` regenerates `core/web.generated.ts` — a `CollectedEntry[]` of `() => import(...)`
loaders with `dependsOn` inferred from import statements. Same discovery substrate for every
collected folder (`server`, `central`, `check`, `lint`, `facet`, …), each marked with
`defineCollectedDir("<folder>")` in its `core/`.

## Bootstrap Flow

`main.tsx` renders `App` → `<PluginProvider plugins={plugins}>` collects every plugin's
contributions into React context → `<RootRenderer>` renders all `Core.Root` contributions.
Those layouts in turn call `.useContributions()` on the slots they define.

## Panes: use `Pane.define`

For opening a view or mounting a URL, use the `pane` plugin (`@plugins/primitives/plugins/pane/web`) — not a command. `defineRoute` declares the URL identity (id, segment, parent); `Pane.define` attaches the component and typed params to it; `Pane.Register` contributes it to the router. See [`plugins/primitives/plugins/pane/CLAUDE.md`](../../../primitives/plugins/pane/CLAUDE.md).

```typescript
// web/panes.ts — the pane reads its own params via the binding it exports
const terminalRoute = defineRoute({ id: "terminal", segment: "terminal/:worktree" });

export const terminalPane = Pane.define({
  route: terminalRoute,
  app: agentManagerApp, // mandatory: the app this pane BELONGS to (its AppRef)
  useResolve: useResolveWorktree, // required: the segment has a `:param`
  component: () => {
    const { worktree } = terminalPane.useParams();
    return <TerminalComponent worktree={worktree} />;
  },
});

// web/index.ts
contributions: [Pane.Register({ pane: terminalPane })]

// consumer
<button onClick={() => terminalPane.open({ worktree: path })}>Launch</button>
```

## Live state, networking, editable fields

`@plugins/framework/plugins/web-sdk/core` is the **framework** only — slots, contributions, plugin context, and the `PluginDefinition` type. Cross-cutting client-side primitives live as plugins under [`plugins/primitives/`](../../../primitives/):

- `<PluginErrorBoundary>`, `ErrorBoundary.Action`, `boundaryReportSink` → `@plugins/primitives/plugins/error-boundary/web`
- `liveValue` / `liveCollection` (declare, `core/`), `serveValue` / `serveCollection` (serve), `useLive` / `useLiveRow` (read) → `@plugins/network/plugins/live/{core,server,web}`; the transport under them (`NotificationsProvider`, the leader-elected `NotificationsClient`) → `@plugins/primitives/plugins/live-state/web`
- `useReconnectingWebSocket`, `ReconnectingEventSource`, `SharedWebSocket`, `fetchWithRetry`, `subscribeWsStatus` → `@plugins/primitives/plugins/networking/web`
- `useEditableField` → `@plugins/primitives/plugins/editable-field/web`

Raw `new EventSource(...)` is forbidden (`./singularity check no-raw-event-source`) — use `ReconnectingEventSource` when consuming the gateway's external log SSE endpoint.

For typed HTTP fetching, use the endpoints primitive (`@plugins/infra/plugins/endpoints/web`): `useEndpoint` (TanStack Query GET), `useEndpointMutation` (POST/PATCH/DELETE with auto-invalidation), or `fetchEndpoint` (imperative). Endpoint contracts are declared once in `core/endpoints.ts` with `defineEndpoint`; the server implements them with `implement()` from `@plugins/infra/plugins/endpoints/server`. See [`plugins/infra/plugins/endpoints/CLAUDE.md`](../../../infra/plugins/endpoints/CLAUDE.md).

## File Structure

Root `CLAUDE.md` → "Folder Structure" and "Plugin boundary rules" cover the per-plugin
folders. The set is closed: a plugin holds only the folders in `plugin-id/core`'s
vocabulary (plus `plugins/` for children), a loose `.ts` at its root is a violation, and
each folder's import row in `tooling/boundaries/core/boundary-config.ts` applies to its own
relative imports too — `web/` may reach its own `core/` and `shared/`, never `../server`.
Inside the web and server folders:

```
plugins/{name}/
├── web/index.ts       # default export: PluginDefinition
├── web/slots.ts       # optional: slots this plugin defines for others to extend
├── web/components/    # internal React components — never inline them in index.ts
├── web/__tests__/     # jsdom/React suites (test code — nothing that ships imports it)
├── web/testing/       # optional: test helpers other suites reuse, @plugins/{name}/web/testing
├── server/index.ts    # default export: ServerPluginDefinition; named exports = public API
├── server/internal/   # handlers, business logic — never imported externally
├── core/testing/      # optional: test helpers both web and server tests use
└── scripts/           # standalone entry points run by path — never imported
```

## Adding a New Plugin

Create `plugins/{name}/web/index.ts`, default-export a `PluginDefinition` whose
contributions target slots imported from the plugins you extend, run `./singularity build`.
Optionally define your own slots in `web/slots.ts`.

Every plugin also has a `package.json` (its `"description"`, `"private": true`, and its
own dependencies). Its `"name"` is **derived from the folder path** — `./singularity build`
(and `./singularity regen-generated`) writes it, and the `plugin-boundaries` check (R1)
fails while it is stale. You still have to put *some* name there, because `bun install`
rejects a workspace member without one and runs before the build's codegen: any placeholder
that no other plugin uses is fine (don't copy a sibling's unchanged — a duplicate name also
fails the install). A moved or renamed plugin needs no name edit at all.

## Styling

Read the `css` and `theme` SKILLs before any UI work (the root `CLAUDE.md` mandates both).
Semantic tokens only — never hardcode colors. Icons are data: `symbol("…")` (Material
Symbols) / `brand("…")` from `ui/icons/core`, drawn by `<Icon icon={…}/>` in the theme
scope's icon style — see [`ui/icons/CLAUDE.md`](../../../ui/plugins/icons/CLAUDE.md). A slot
or prop takes `icon: IconRef`, never a component; `react-icons` and `lucide-react` are
banned by the `icon-safety` lint rules.
UI primitives and `cn()` come from `@plugins/primitives/plugins/css/plugins/ui-kit/web` —
see [`ui-kit/CLAUDE.md`](../../../primitives/plugins/css/plugins/ui-kit/CLAUDE.md).

## Umbrella Plugins

An umbrella is a grouping shell that nests related sub-plugins under `plugins/`. It needs only a `package.json` with a `"description"`, the `plugins/` subdirectory, and its `CLAUDE.md` (auto-generated by `./singularity build`). No `web/index.ts` or `server/index.ts` unless the umbrella itself has contributions, exports, or routes.

## Key Design Decisions

- **Per-plugin error isolation (web)** — web plugins use dynamic `import()` for per-plugin error isolation; server/central use static imports. All plugins are known at build time (the generated registry lists them)
- **No dependencies field** — import statements enforce dependency at build time
- **No lifecycle hooks** — plugins use React's own lifecycle (useEffect, etc.)
- **Slots are the only extension mechanism** — no special `root`, `background`, or other fields

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Web plugin runtime: slots, contributions, loader
- Web:
  - Slots:
    - `Core.Root`
    - `Core.Boot`
  - Slot contributors: 39 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `Core.Root` ×37
    - `Core.Boot` ×2
- Core:
  - Uses:
    - `framework/plugin-id.asPluginId`
    - `framework/plugin-loader.topoSortPlugins`
    - `framework/slot-declaration.declarePluginSlots`
    - `framework/slot-declaration.recordCreatedSlot`
    - `framework/slot-declaration.slotIdFor`
    - `framework/tooling/collected-dir.defineCollectedDir`
  - Exports (types):
    - `CompositionIdentity`
    - `Contribution`
    - `DeferredLoadState`
    - `DocMeta`
    - `LoadedPlugin`
    - `PluginDefinition`
    - `PluginEntry`
    - `PluginLoadError`
    - `PluginLoadReport`
    - `PluginRegistry`
    - `SealContributions`
    - `SealedComponent`
    - `SealedMeta`
    - `Slot`
    - `SlotReadDetail`
  - Exports (values):
    - `Core`
    - `createPluginRegistry`
    - `defineSlot`
    - `defineSlotFacade`
    - `getDeferredLoadState`
    - `hasLoadErrorUnder`
    - `isDeferredPluginPath`
    - `loadPlugins`
    - `markDeferredLoadComplete`
    - `markDeferredPluginsFailed`
    - `markDeferredPluginsLoaded`
    - `partitionWebEntries`
    - `pluginLoadReportSink`
    - `PluginProvider`
    - `SLOT_READ_TIMING_PREFIX`
    - `slots`
    - `subscribeDeferredLoadState`
    - `UNSAFE_unsealSlotComponent`
    - `useComposition`
    - `useDeferredLoadComplete`
    - `useFailedPluginPaths`
    - `useHasLoadErrorUnder`
    - `useRawContributions`
    - `webCollectedDir`
- Test helpers:
  - Core: `@plugins/framework/plugins/web-sdk/core/testing`
    - `resetDeferredLoadStateForTests` — TEST-ONLY: reset the module-global deferred-load state to its initial values (empty loaded/failed sets, not-yet-settled) and notify subscribers.

<!-- AUTOGENERATED:END -->
