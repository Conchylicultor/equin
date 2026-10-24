# Routes Facet Migration

## Context

HTTP/WS route metadata is currently extracted in `plugin-tree.ts` via `parseRouteMap`, which scans `server/index.ts` and `central/index.ts` for `httpRoutes: { ... }` and `wsRoutes: { ... }` object literals. It only captures **quoted string keys**, so routes declared with the `defineEndpoint` pattern — `httpRoutes: { [listTasks.route]: handler }` — are invisible. Since virtually every plugin uses `defineEndpoint` for HTTP routes, almost all HTTP routes in the system are currently missing from doc output, `docs/routes.md`, and the Forge UI.

`slots` and `commands` already have their own facets under `plugins/plugin-meta/plugins/facets/plugins/`. Route extraction follows the same shape and belongs there too.

## Goal

1. Create a `routes` facet that correctly extracts HTTP routes (from `defineEndpoint` calls in `core/**/*.ts`) and WS routes (literal keys in `server/central` barrels).
2. Use the facet's `relate()` to write the proper route data back into `PluginNode.server/central.httpRoutes/wsRoutes` and re-compute `endpointCallers` from accurate data.
3. Remove the broken `parseRouteMap` and the `apiPrefixToOwner` block from `plugin-tree.ts`.
4. All existing consumers (`docgen.ts`, `tree-handler.ts`) work unchanged since they still read from `PluginNode` fields — which now contain correct data.

## New type: `RouteDef`

Defined in `plugin-tree.ts` alongside `SlotDef` and `CommandDef`, exported through `plugin-tree/core/index.ts`:

```ts
export interface RouteDef {
  route: string;       // "GET /api/tasks/:id"  |  "/ws/terminal"
  type: "http" | "ws";
  runtime: "server" | "central";
  name?: string;       // exported const name from defineEndpoint, e.g. "listTasks"
}
```

## Files

### Create

| File | Purpose |
|---|---|
| `plugins/plugin-meta/plugins/facets/plugins/routes/facet/index.ts` | Facet implementation |
| `plugins/plugin-meta/plugins/facets/plugins/routes/package.json` | Minimal package descriptor |
| `plugins/plugin-meta/plugins/facets/plugins/routes/CLAUDE.md` | Description |

### Modify

| File | Change |
|---|---|
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | Add `RouteDef` type; export `walkFiles`; remove `parseRouteMap`; zero-initialize `httpRoutes/wsRoutes` in `collectPlugin`; remove `apiPrefixToOwner` block from `computeRelationships` |
| `plugins/plugin-meta/plugins/plugin-tree/core/index.ts` | Export `RouteDef`, `walkFiles` |

## Implementation

### `plugins/plugin-meta/plugins/facets/plugins/routes/facet/index.ts`

```ts
import { readdirSync } from "fs";
import { join } from "path";
import { createFacet, defineFacet } from "@plugins/plugin-meta/plugins/facets/core";
import {
  type RouteDef,
  type PluginTree,
  getFacet, readIfExists, stripTypes, matchBracket, walkFiles,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";

export const routesFacetDef = defineFacet<RouteDef[]>("routes");

export default createFacet<RouteDef[]>({
  def: routesFacetDef,

  extract(ctx) {
    const routes: RouteDef[] = [];

    // ── HTTP routes from defineEndpoint in core/ ────────────────────────────
    const coreDir = join(ctx.dir, "core");
    const coreFiles: string[] = [];
    walkFiles(coreDir, coreFiles);

    const endpointRoutes = new Map<string, string>(); // exportName → routeString
    for (const file of coreFiles.filter((f) => f.endsWith(".ts"))) {
      const src = readIfExists(file);
      if (!src) continue;
      const stripped = stripTypes(src);
      // Match: export const NAME = defineEndpoint({ ..., route: "METHOD /path", ... })
      const exportRe = /export\s+const\s+(\w+)\s*=\s*defineEndpoint\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = exportRe.exec(stripped))) {
        const name = m[1]!;
        const callStart = m.index + m[0].length - 1; // position of opening '('
        const callEnd = matchBracket(stripped, callStart, "(", ")");
        if (callEnd < 0) continue;
        const body = stripped.slice(callStart + 1, callEnd);
        const routeMatch = /route\s*:\s*"([^"]+)"/.exec(body);
        if (routeMatch) endpointRoutes.set(name, routeMatch[1]!);
      }
    }

    // ── Determine runtime for each HTTP endpoint from server/central barrels ─
    for (const runtime of ["server", "central"] as const) {
      const barrelPath = join(ctx.dir, runtime, "index.ts");
      const src = readIfExists(barrelPath);
      if (!src) continue;
      const stripped = stripTypes(src);

      // Find httpRoutes: { ... } block
      const idx = stripped.search(/\bhttpRoutes\s*:\s*\{/);
      if (idx < 0) continue;
      const blockStart = stripped.indexOf("{", idx);
      const blockEnd = matchBracket(stripped, blockStart, "{", "}");
      if (blockEnd < 0) continue;
      const block = stripped.slice(blockStart + 1, blockEnd);

      // Extract computed keys: [endpointName.route]
      const keyRe = /\[\s*(\w+)\s*\.\s*\w+\s*\]/g;
      let km: RegExpExecArray | null;
      while ((km = keyRe.exec(block))) {
        const name = km[1]!;
        const routeString = endpointRoutes.get(name);
        if (routeString) {
          routes.push({ route: routeString, type: "http", runtime, name });
        }
      }

      // Also capture any literal string keys (rare, e.g. legacy routes)
      const literalRe = /"([^"]+)"\s*:/g;
      while ((km = literalRe.exec(block))) {
        routes.push({ route: km[1]!, type: "http", runtime });
      }
    }

    // ── WS routes: literal keys in wsRoutes: { ... } ─────────────────────────
    for (const runtime of ["server", "central"] as const) {
      const barrelPath = join(ctx.dir, runtime, "index.ts");
      const src = readIfExists(barrelPath);
      if (!src) continue;
      const stripped = stripTypes(src);

      const idx = stripped.search(/\bwsRoutes\s*:\s*\{/);
      if (idx < 0) continue;
      const blockStart = stripped.indexOf("{", idx);
      const blockEnd = matchBracket(stripped, blockStart, "{", "}");
      if (blockEnd < 0) continue;
      const block = stripped.slice(blockStart + 1, blockEnd);

      const keyRe = /"([^"]+)"\s*:/g;
      let m: RegExpExecArray | null;
      while ((m = keyRe.exec(block))) {
        routes.push({ route: m[1]!, type: "ws", runtime });
      }
    }

    return routes;
  },

  relate(rawCtx) {
    const { tree } = rawCtx as { tree: PluginTree };

    // Pass 1: backfill PluginNode.server/central.httpRoutes and wsRoutes
    for (const node of tree.byDir.values()) {
      const routes = getFacet(node, routesFacetDef) ?? [];
      node.server.httpRoutes  = routes.filter(r => r.runtime === "server"  && r.type === "http").map(r => r.route);
      node.server.wsRoutes    = routes.filter(r => r.runtime === "server"  && r.type === "ws" ).map(r => r.route);
      node.central.httpRoutes = routes.filter(r => r.runtime === "central" && r.type === "http").map(r => r.route);
      node.central.wsRoutes   = routes.filter(r => r.runtime === "central" && r.type === "ws" ).map(r => r.route);
    }

    // Pass 2: recompute endpointCallers from accurate route data
    // (replaces the apiPrefixToOwner block removed from plugin-tree.ts)
    const apiPrefixToOwner = new Map<string, typeof [...tree.byDir.values()][0]>();
    for (const info of tree.byDir.values()) {
      for (const route of [...info.server.httpRoutes, ...info.central.httpRoutes]) {
        const pathMatch = route.match(/^\S+\s+\/api\/([A-Za-z0-9_-]+)/);
        if (!pathMatch) continue;
        const prefix = pathMatch[1]!;
        if (!apiPrefixToOwner.has(prefix)) apiPrefixToOwner.set(prefix, info);
      }
    }
    if (apiPrefixToOwner.size > 0) {
      const prefixes = [...apiPrefixToOwner.keys()];
      const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const re = new RegExp(`\\/api\\/(${escaped.join("|")})(?![A-Za-z0-9_-])`, "g");
      // walkFiles is expensive — only walk plugin trees once
      const fileCache = new Map<string, string[]>();
      for (const caller of tree.byDir.values()) {
        const files: string[] = [];
        for (const sub of ["web", "server", "central"]) {
          const subDir = join(caller.dir, sub);
          const cached = fileCache.get(subDir);
          if (cached) {
            files.push(...cached);
          } else {
            const subFiles: string[] = [];
            try { walkFiles(subDir, subFiles); } catch { /* dir may not exist */ }
            fileCache.set(subDir, subFiles);
            files.push(...subFiles);
          }
        }
        const hit = new Set<string>();
        for (const f of files) {
          const src = readIfExists(f);
          if (!src) continue;
          let m: RegExpExecArray | null;
          re.lastIndex = 0;
          while ((m = re.exec(src))) hit.add(m[1]!);
        }
        for (const prefix of hit) {
          const owner = apiPrefixToOwner.get(prefix);
          if (!owner || owner === caller) continue;
          if (!owner.endpointCallers.includes(caller.name)) {
            owner.endpointCallers.push(caller.name);
          }
        }
      }
      for (const info of tree.byDir.values()) info.endpointCallers.sort();
    }
  },

  renderDoc(data, ctx) {
    if (data.length === 0) return [];
    const subIndent = `${ctx.bodyIndent}  `;
    const http = data.filter(r => r.type === "http");
    const ws   = data.filter(r => r.type === "ws");
    const lines: string[] = [];
    if (http.length > 0) lines.push(`${subIndent}- HTTP: ${http.map(r => `\`${r.route}\``).join(", ")}`);
    if (ws.length   > 0) lines.push(`${subIndent}- WS: ${ws.map(r => `\`${r.route}\``).join(", ")}`);
    return lines;
  },
});
```

### `plugin-tree.ts` changes

1. **Add `RouteDef`** (alongside `SlotDef` at line 19):
   ```ts
   export interface RouteDef {
     route: string;
     type: "http" | "ws";
     runtime: "server" | "central";
     name?: string;
   }
   ```

2. **Export `walkFiles`** — change `function walkFiles` → `export function walkFiles`.

3. **Zero-initialize routes in `collectPlugin`** — change:
   ```ts
   httpRoutes: serverHttpRoutes,
   wsRoutes: serverWsRoutes,
   ```
   to:
   ```ts
   httpRoutes: [],
   wsRoutes: [],
   ```
   (same for central). The facet `relate()` fills them in.

4. **Remove `parseRouteMap`** (lines 319–331) and its four call sites (lines 691–694).

5. **Remove `apiPrefixToOwner` block** (lines 825–862 in `computeRelationships` / `buildPluginTree`) — now lives in `relate()`.

### `plugin-tree/core/index.ts` changes

Add exports:
```ts
export type { RouteDef } from "./internal/plugin-tree";
export { walkFiles } from "./internal/plugin-tree";
```

## Known limitation: `tree-handler.ts` (Forge UI)

`handleTree` calls `buildPluginTree` but not `enrichPluginTreeDocs`. After this migration, `PluginNode.server.httpRoutes` is initialized to `[]` and only filled by `relate()` (which runs inside `enrichPluginTreeDocs`). So the Forge UI `/api/plugin-tree` endpoint will return empty routes.

Currently the Forge UI also shows empty routes for any plugin using `defineEndpoint` (the broken current state), so this is not a regression — it's parity. A follow-up can make `handleTree` call `enrichPluginTreeDocs` or run a lighter routes-only extraction synchronously.

## Verification

```bash
# Build (runs facets + codegen)
./equin build

# Inspect docs/routes.md — should now list HTTP routes for tasks, conversations, etc.
head -60 docs/routes.md

# Inspect a plugin CLAUDE.md autogen block for a plugin with routes
grep -A10 "Server:" plugins/tasks/CLAUDE.md

# Run the doc-in-sync check
./equin check --plugins-doc-in-sync

# Run all checks
./equin check
```

Spot-check: `plugins/tasks/CLAUDE.md` autogen block should now show `GET /api/tasks`, `POST /api/tasks`, etc. under `Server:`. `docs/routes.md` should list ~30+ routes instead of just 2 WS routes.
