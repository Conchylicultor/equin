# Step 1: Facet Foundation — defineFacet Primitive + Wildcard Bun Stub

## Context

This is Step 1 of the [unified facet-based docgen plan](./2026-05-20-global-unified-facet-docgen.md). Two changes that unblock the rest of the chain:

1. **No extensible metadata primitive on PluginNode.** The `PluginNode` type (`plugin-tree/core/internal/plugin-tree.ts:75-107`) has ~30 hardcoded fields. Adding new metadata means touching the type, the builder, the barrel, and every consumer. A `facets: Record<string, unknown>` bag with typed accessors (`defineFacet`/`getFacet`/`setFacet`) lets future steps add metadata without modifying `PluginNode`.

2. **Barrel-import stubs are manually enumerated.** `barrel-import/core/internal/stubs.ts` lists every npm package that web barrels transitively import (~10 packages). Adding a new dependency breaks docgen until someone adds a stub. A wildcard catch-all makes this self-healing.

Both changes are additive and non-breaking — existing code continues to work identically.

## Part 1: defineFacet Primitive

### New file: `plugins/plugin-meta/plugins/plugin-tree/core/internal/facets.ts`

```typescript
export interface FacetDef<T> {
  id: string;
  _phantom?: T;
}

export function defineFacet<T>(id: string): FacetDef<T> {
  return { id };
}

export function getFacet<T>(node: { facets: Record<string, unknown> }, def: FacetDef<T>): T | undefined {
  return node.facets[def.id] as T | undefined;
}

export function setFacet<T>(node: { facets: Record<string, unknown> }, def: FacetDef<T>, data: T): void {
  node.facets[def.id] = data;
}
```

### Modify `plugin-tree.ts`

Add `facets: Record<string, unknown>` to `PluginNode` interface (line ~86, after `children`):

```typescript
export interface PluginNode {
  // ... existing fields ...
  children: PluginNode[];
  facets: Record<string, unknown>;  // ← new, typed access via getFacet/setFacet
  // ... rest unchanged ...
}
```

Initialize in `collectPlugin` return (line ~739, after `children: []`):

```typescript
children: [],
facets: {},
```

### Modify `plugin-tree/core/index.ts`

Add exports:

```typescript
export { defineFacet, getFacet, setFacet } from "./internal/facets";
export type { FacetDef } from "./internal/facets";
```

## Part 2: Wildcard Bun Stub

### Approach

Replace the manually-enumerated npm package stubs with a `build.onResolve` wildcard that redirects unrecognized bare specifiers to a single stub path, plus a `build.onLoad` that provides a CJS proxy module for that path. This avoids the "virtual namespace" issue noted in the existing comment (line 224-226) because it stays in the default `"file"` namespace.

**How named imports work**: The `onLoad` returns CJS (`module.exports = Proxy`). Bun's CJS-to-ESM interop accesses `module.exports.PropertyName` for named imports, which the Proxy's `get` trap handles by returning `noop`.

### Stubs to KEEP (structurally required)

These provide behavioral shapes that barrel-import code reads at module evaluation time:

| Stub | Why |
|------|-----|
| `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`, `react-dom/client` | Hooks (`useState`, `useMemo`, `useContext`) are called at module level; need real return shapes |
| `@plugins/framework/plugins/web-sdk/core` | `defineSlot`/`defineCommand` attach `_slotId` to contributions; `collectSlotDisplayNames` reads `.id` and `.useContributions` |
| `@plugins/config/server` | `Config.Field()` returns `{ _kind, _doc, ...props }` — config-origin-gen reads field descriptors |
| `@plugins/database/server` | `db`/`awaitDbReady` imported at top-level by 12+ server barrels |
| globalThis shims (window, document, observers) | DOM-accessing web code runs at module init |
| CSS `build.onLoad({ filter: /\.css$/ })` | Side-effect CSS imports → empty JS |

### Stubs to REMOVE (replaced by wildcard)

`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `react-diff-view`, `react-resizable-panels`, and the 3 explicit CSS subpath stubs (`@xterm/xterm/css/xterm.css`, `@xyflow/react/dist/style.css`, `react-diff-view/style/index.css`).

### Implementation

Add wildcard AFTER all explicit `build.module()` stubs (which take priority over `onResolve`):

```typescript
// ── Wildcard: catch all unrecognized bare specifiers ──────────────
// Replaces manual per-package stubs. build.module() registrations
// (React, web-sdk, config, database) take priority over onResolve,
// so structurally-required stubs are unaffected.
//
// Uses onResolve → onLoad in the default "file" namespace (NOT a
// virtual namespace, which breaks for static ESM in Bun runtime
// plugins per the comment above).

const STUB_SENTINEL = "/__barrel_empty_stub__";

const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster",
  "console", "constants", "crypto", "dgram", "diagnostics_channel",
  "dns", "domain", "events", "fs", "http", "http2", "https",
  "inspector", "module", "net", "os", "path", "perf_hooks",
  "process", "punycode", "querystring", "readline", "repl",
  "stream", "string_decoder", "sys", "timers", "tls", "tty",
  "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

build.onResolve({ filter: /^[^./]/ }, (args) => {
  const spec = args.path;
  // Let @plugins/* resolve via tsconfig paths
  if (spec.startsWith("@plugins/")) return undefined;
  // Let Bun/Node built-ins resolve natively
  if (spec.startsWith("bun:") || spec.startsWith("node:")) return undefined;
  // Let Node.js built-in bare names resolve natively
  const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
  if (NODE_BUILTINS.has(pkgName)) return undefined;
  // Everything else → empty proxy stub
  return { path: STUB_SENTINEL };
});

build.onLoad({ filter: /\/__barrel_empty_stub__$/ }, () => ({
  contents: [
    "const noop = () => {};",
    "const handler = {",
    "  get: (t, k) => {",
    "    if (k === '__esModule') return true;",
    "    if (k === 'default') return t;",
    "    if (typeof k === 'symbol') return undefined;",
    "    return noop;",
    "  },",
    "};",
    "module.exports = new Proxy(noop, handler);",
  ].join("\n"),
  loader: "js",
}));
```

### Why `onResolve` + `onLoad` works (no virtual namespace)

The existing comment (line 224-226) warns: *"onResolve+onLoad virtual namespaces break for static imports within ESM module graphs."* The warning is about returning `{ path, namespace: "custom" }` from `onResolve` — a custom namespace requires a paired `onLoad({ namespace: "custom" })` handler, and Bun's runtime plugin system doesn't support this for static ESM `import` statements.

Our approach does NOT use a custom namespace. `onResolve` returns `{ path: "/__barrel_empty_stub__" }` in the default `"file"` namespace. `onLoad` matches on the path regex in the default namespace. This is the same pattern the existing CSS handler uses (`build.onLoad({ filter: /\.css$/ })`).

### Edge cases

- **CSS subpath imports** (e.g., `@xterm/xterm/css/xterm.css`): The `onResolve` catches the bare specifier first, redirecting to the stub. The CSS `onLoad` filter (`/\.css$/`) does NOT match `/__barrel_empty_stub__`. The general `onLoad` handles it instead, returning the CJS proxy. Side-effect CSS imports get an empty-ish module — harmless.
- **`build.module` priority**: Bun evaluates `build.module()` registrations before `build.onResolve()`. So `react`, `@plugins/config/server`, etc. are handled by their explicit stubs and never reach the wildcard.
- **Subpath imports** (e.g., `drizzle-orm/pg-core`): If the main package has no `build.module`, the `onResolve` catches the subpath specifier too (it starts with `d`, not `.` or `/`). The entire package subtree resolves to the empty stub.

## Files Modified

| File | Change |
|------|--------|
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/facets.ts` | **New** — `defineFacet`, `getFacet`, `setFacet` |
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | Add `facets: Record<string, unknown>` to `PluginNode`; init `facets: {}` in `collectPlugin` |
| `plugins/plugin-meta/plugins/plugin-tree/core/index.ts` | Export `defineFacet`, `getFacet`, `setFacet`, `FacetDef` |
| `plugins/plugin-meta/plugins/barrel-import/core/internal/stubs.ts` | Remove 8 npm stubs + 3 CSS subpath stubs; add wildcard `onResolve` + `onLoad` |

## Verification

1. `./equin build` succeeds (barrel imports, migrations, docs all regenerate)
2. `diff` on `docs/plugins-compact.md`, `docs/plugins-details.md`, `docs/routes.md` — empty (doc output unchanged)
3. Spot-check 2-3 per-plugin `CLAUDE.md` autogen blocks — unchanged
4. `./equin check` passes all checks

## Risks

| Risk | Mitigation |
|------|-----------|
| `onResolve+onLoad` in default namespace might still break for some Bun version | We're not using virtual namespaces. If it breaks, fall back to scanning `node_modules/` and registering `build.module()` per package. |
| CJS proxy doesn't provide named exports via Bun's interop | Test with `import { Terminal } from "@xterm/xterm"` pattern — if Bun can't resolve named exports from the CJS proxy, switch to scanning node_modules with `build.module` + `loader: "object"` per package. |
| Node.js built-in set is incomplete | Use `module.builtinModules` from Node.js/Bun at runtime instead of hardcoded set if any built-in is missed. |
| Wildcard stubs break a package that needs structural fidelity | Only React/web-sdk/config/database need it. If another package surfaces, add it to the explicit stubs. |
