# Auto-documentable Contribution Types

## Context

The plugin docgen (`tooling/src/docgen.ts`) has two problems:

1. **Web contributions render via hardcoded field-sniffing.** `renderContribution()` checks for `paneId`, then `pattern`, then `title`, then `label` in priority order. When a new contribution type uses a prop name not in this list, the rendered doc shows only the bare slot name with no detail.

2. **Server contributions are invisible.** `register: [addTaskTool, classifyConversationJob]` is collected as raw variable names (`parseRegisterTokens` in `plugin-tree.ts:456-482`). The docgen has no access to the metadata inside these tokens (MCP tool names, job names, event names). `trigger()` bindings in `onReady` are completely invisible.

The goal: each contribution/registration factory attaches doc metadata to the objects it produces, and the docgen reads it generically — no hardcoded knowledge of specific contribution types. The metadata is also available at runtime for plugins like `plugin-view` to display.

**Scope constraint:** No changes to existing factory APIs. Only add `_doc` metadata and update the docgen to read it.

## Design

### `DocMeta` — the metadata type

New type in `plugin-core/types.ts` (so it's available to both web and server, and to runtime consumers like `plugin-view`):

```ts
export interface DocMeta {
  /** Human-readable label for this specific contribution. */
  label?: string;
  /** Optional extra detail (description excerpt, path, etc.). */
  detail?: string;
}
```

`kind` is **not** on `DocMeta` — it is always auto-inferred from structural identity:
- For web `Contribution` objects → `_slotId` (e.g. `"shell.sidebar"`)
- For `ServerContribution` objects → the Symbol debug name (from `defineServerContribution(debugName)`)
- For `Registration` tokens → a new readonly `_kind: string` field set internally by each factory

This makes it impossible to manually set an inconsistent kind.

### `_doc` is NOT stripped

Unlike internal fields, `_doc` is **kept** on contribution objects at runtime. This lets plugins like `plugin-view` access and display contribution metadata in the UI. The `useContributions()` and `getContributions()` methods continue stripping `_slotId`/`_kind` (internal framework plumbing) but preserve `_doc` alongside consumer props.

### Where `_doc` is attached

Each factory attaches `_doc: DocMeta` to the objects it already produces. No new APIs — just an extra field.

**Web slot contributions** — `defineSlot` in `plugin-core/slots.ts`:

Add an optional second arg with a `docLabel` extractor:

```ts
export function defineSlot<P>(
  id: string,
  opts?: { docLabel?: (props: P) => string | undefined },
): Slot<P> {
  const slot = ((props: P) => ({
    _slotId: id,
    _doc: { label: opts?.docLabel?.(props) },
    ...props,
  })) as unknown as Slot<P>;
  // ... rest unchanged
}
```

Each existing slot definition adds `docLabel`:
- `Shell.Sidebar`: `{ docLabel: (p) => p.title }`
- `Shell.Toolbar`: `{ docLabel: (p) => p.id }`
- `Pane.Register`: `{ docLabel: (p) => p.pane?.id }`
- `Config.Section`: `{ docLabel: (p) => p.title }`
- etc.

**Server `defineServerContribution`** — `server/src/contributions.ts`:

Same pattern — add optional `docLabel`:

```ts
export function defineServerContribution<P>(
  debugName: string,
  opts?: { docLabel?: (props: P) => string | undefined },
): ServerContributionToken<P> {
  const kind = Symbol(debugName);
  const token = ((props: P) => ({
    _kind: kind,
    _doc: { label: opts?.docLabel?.(props) },
    ...props,
  })) as unknown as ServerContributionToken<P>;
  // ...
}
```

**Server `Registration` tokens** — add `_kind` and `_doc` to the interface:

```ts
// plugin-core/types.ts AND server/src/types.ts (both define Registration)
export interface Registration {
  register(): void | Promise<void>;
  /** Auto-set by the factory. Never manually specified. */
  readonly _kind?: string;
  _doc?: DocMeta;
}
```

Each factory sets both internally:

| Factory | `_kind` | `_doc` | File |
|---|---|---|---|
| `Mcp.tool(tool)` | `"mcp-tool"` | `{ label: tool.name, detail: first line of tool.description }` | `plugins/infra/plugins/mcp/server/internal/mcp.ts` |
| `defineJob(spec)` | `"job"` | `{ label: spec.name }` | `plugins/infra/plugins/jobs/server/internal/registry.ts` |
| `defineTriggerEvent(spec)` | `"trigger-event"` | `{ label: spec.name }` | `plugins/infra/plugins/events/server/internal/event.ts` |
| `UNSAFE_installDurableHooks()` | `"durable-hooks"` | `{}` | `plugins/infra/plugins/jobs/server/internal/step-ctx.ts` |

### Browser stubs — a reusable plugin-meta primitive

The ability to import web barrels in a non-browser Bun context is useful beyond docgen (plugin introspection, analysis tools, future testing). Rather than burying stubs in `tooling/`, this is a **new sub-plugin of `plugin-meta`**: `plugin-meta/plugins/barrel-import`.

No existing npm library provides React module stubs for non-browser contexts. The only viable mechanism is Bun's `Bun.plugin()` API with `build.module()` for virtual modules.

**Location:** `plugins/plugin-meta/plugins/barrel-import/`

This plugin has no `web/` or `server/` runtime — it's a **shared** utility:
- `shared/index.ts` — exports `registerBarrelStubs()` and `importBarrel(path)`
- `shared/internal/stubs.ts` — the Bun plugin registration (React, JSX runtime, react-dom, react-icons, CSS, path aliases)

```ts
// shared/index.ts
export { registerBarrelStubs, importBarrel } from "./internal/stubs";
```

```ts
// shared/internal/stubs.ts
let registered = false;

export function registerBarrelStubs(repoRoot: string): void {
  if (registered) return;
  registered = true;

  Bun.plugin({
    name: "barrel-import-stubs",
    setup(build) {
      // React — hooks return inert values
      build.module("react", () => ({ exports: { /* ... */ }, loader: "object" }));
      // react/jsx-runtime, react/jsx-dev-runtime
      // react-dom, react-dom/client
      // react-icons/* via onResolve + onLoad proxy
      // .css → empty
      // Path aliases: @core, @/*, @server/*
    },
  });
}

export async function importBarrel(barrelPath: string): Promise<{ default: unknown } | null> {
  try {
    return await import(barrelPath);
  } catch (e) {
    console.warn(`[barrel-import] Failed to import ${barrelPath}: ${e}`);
    return null;
  }
}
```

The docgen and `plugin-tree` import from `@plugins/plugin-meta/plugins/barrel-import/shared`. Any future tool that needs to introspect web barrels uses the same primitive.

### Collection in `plugin-tree` (stays in plugin-meta)

The runtime collection logic lives in `plugin-meta/plugins/plugin-tree/shared/internal/plugin-tree.ts` — where `buildPluginTree` already lives. Replace the regex-based `extractContributionsBlock` + `findCalls` + `parsePropsBlock` pipeline with:

```ts
import { registerBarrelStubs, importBarrel } from "@plugins/plugin-meta/plugins/barrel-import/shared";

// Called once at the start of buildPluginTree
registerBarrelStubs(repoRoot);

async function collectRuntimeContributions(dir: string, runtime: "web" | "server" | "central") {
  const barrelPath = join(dir, runtime, "index.ts");
  if (!existsSync(barrelPath)) return { contributions: [], registrations: [] };

  const mod = await importBarrel(barrelPath);
  if (!mod) return { contributions: [], registrations: [] };

  const def = mod.default as any;
  const contributions = (def.contributions ?? [])
    .filter((c: any) => c._doc)
    .map((c: any) => ({ slotId: c._slotId, doc: c._doc as DocMeta }));
  const registrations = (def.register ?? [])
    .filter((r: any) => r._doc)
    .map((r: any) => ({ kind: r._kind as string, doc: r._doc as DocMeta }));

  return { contributions, registrations };
}
```

`PluginNode` gains structured fields instead of the current flat `Contribution[]`:

```ts
export interface PluginNode {
  // ... existing fields ...
  contributions: { slotId: string; doc: DocMeta }[];
  registrations: { kind: string; doc: DocMeta }[];
}
```

### Rendering in docgen (stays in tooling)

`renderContribution()` in `tooling/src/docgen.ts` becomes generic — no field-sniffing:

```ts
function renderContribution(c: { slotId: string; doc: DocMeta }): string {
  const parts = [`\`${c.slotId}\``];
  if (c.doc.label) parts.push(`"${c.doc.label}"`);
  if (c.doc.detail) parts.push(`(${c.doc.detail})`);
  return parts.join(" ");
}

function renderRegistration(r: { kind: string; doc: DocMeta }): string {
  const parts = [`\`${r.kind}\``];
  if (r.doc.label) parts.push(`"${r.doc.label}"`);
  if (r.doc.detail) parts.push(`(${r.doc.detail})`);
  return parts.join(" ");
}
```

### Runtime display in plugin-view

`plugin-view`'s `toApiNode()` currently strips contributions. Once `PluginNode` carries the new structured fields, `toApiNode()` includes them in the API response, and a new `PluginView.Section` sub-plugin renders them in the detail pane (contributions list, registrations list). This is a natural follow-up but not blocking for the core docgen work.

## What changes per file

**Framework (add `_doc`, `DocMeta`):**
- `plugin-core/types.ts` — add `DocMeta` interface; add `_doc?: DocMeta` to `Contribution`; add `_kind?: string` and `_doc?: DocMeta` to `Registration`
- `plugin-core/slots.ts` — add optional `opts` param to `defineSlot`; attach `_doc`
- `server/src/types.ts` — add `_kind?: string` and `_doc?: DocMeta` to `Registration`
- `server/src/contributions.ts` — add optional `opts` param to `defineServerContribution`; attach `_doc`

**Server factories (attach `_kind` + `_doc`):**
- `plugins/infra/plugins/mcp/server/internal/mcp.ts` — `Mcp.tool()`
- `plugins/infra/plugins/jobs/server/internal/registry.ts` — `defineJob()`
- `plugins/infra/plugins/events/server/internal/event.ts` — `defineTriggerEvent()`
- `plugins/infra/plugins/jobs/server/internal/step-ctx.ts` — `UNSAFE_installDurableHooks()`

**Slot definitions (add `docLabel`):**
Every file that calls `defineSlot(id)` needs `defineSlot(id, { docLabel: ... })`. Key files:
- `plugins/shell/web/slots.ts` — Shell.Sidebar, Shell.Toolbar, Shell.StatusBar
- `plugins/primitives/plugins/pane/web/slots.ts` — Pane.Register
- `plugins/config/web/slots.ts` — Config.Spec, Config.Section
- `plugins/active-data/web/slots.ts` — ActiveData.Tag, ActiveData.Inline
- (scan all `defineSlot` call sites — `rg 'defineSlot' plugins/`)

**New plugin — `plugin-meta/plugins/barrel-import/`:**
- `shared/index.ts` — barrel exporting `registerBarrelStubs` and `importBarrel`
- `shared/internal/stubs.ts` — Bun plugin registering React/CSS/icon/alias stubs
- `package.json` — workspace entry with description

**Plugin-tree (replace static parsing with runtime import):**
- `plugins/plugin-meta/plugins/plugin-tree/shared/internal/plugin-tree.ts` — replace `extractContributionsBlock` + `findCalls` + `parsePropsBlock` + `parseRegisterTokens` with `collectRuntimeContributions()`; update `PluginNode` type
- `plugins/plugin-meta/plugins/plugin-tree/shared/index.ts` — re-export `DocMeta`

**Docgen (generic rendering):**
- `tooling/src/docgen.ts` — replace `renderContribution()` with generic `renderContribution` + `renderRegistration` using `DocMeta`; remove `Contribution` import from plugin-tree

**Cleanup (remove after migration):**
- Remove `extractContributionsBlock`, `findCalls`, `parsePropsBlock`, `parseRegisterTokens` from `plugin-tree.ts`
- Remove the old static-parse `Contribution` interface from `plugin-tree.ts`

## Risks and Mitigations

**Stub completeness.** Some transitive import (Radix, Tanstack Query, etc.) might fail with our React stubs. Mitigation: the stub surface grows incrementally — add a `build.module()` for any library that crashes, test with `./equin build`. The `try/catch` in `importBarrel` logs warnings for individual failures without blocking the entire docgen.

**Path alias resolution.** Web barrels use `@core`, `@/*`, `@server/*` which aren't in `tooling/tsconfig.json`. Mitigation: the Bun plugin's `onResolve` handlers resolve these relative to the repo root.

**`buildPluginTree` becomes async.** Currently synchronous (file reads). With dynamic `import()`, it becomes async. Callers already await `generatePluginDocs()`, so this is a straightforward change.

## Verification

1. Run `./equin build` — should succeed and regenerate docs
2. Check `docs/plugins-details.md` — contributions should render with labels from `_doc`
3. Check that server `register` tokens now show semantic names instead of variable names (e.g. `mcp-tool "add_task"` instead of `addTaskTool`)
4. Check per-plugin `CLAUDE.md` autogen blocks match
5. Run `./equin check --plugins-doc-in-sync` — should pass
6. Intentionally break a barrel (add `document.body` at top level) → the `try/catch` should log a warning and the build should still succeed
