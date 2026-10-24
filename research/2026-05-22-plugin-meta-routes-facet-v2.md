# Routes Facet (Step 3 of Unified Facet Docgen)

## Context

This is **Step 3** of the [unified facet-based docgen plan](2026-05-20-global-unified-facet-docgen.md). Steps 1 (foundation) and 2 (commands facet) are complete; the slots facet is concurrent.

The goal of Step 3 is: *all metadata lives in facets; monolithic fields are still populated (dual-write)*. Each facet sub-plugin mirrors what `collectPlugin()` does for one metadata type — extracting into `node.facets[id]` alongside the existing monolithic fields. Doc output stays byte-identical except for intended improvements.

### Routes-specific problem

`parseRouteMap` (the monolithic extractor) only captures **quoted string keys** in `httpRoutes: { "literal": handler }`. Almost every plugin uses computed keys `[endpoint.route]` from `defineEndpoint`. So `node.server.httpRoutes` is empty for most plugins, `endpointCallers` is broken, and `docs/routes.md` shows only 2 WS routes instead of ~30+ HTTP routes.

The routes facet fixes the extraction. The `relate()` callback overwrites `node.endpointCallers` with accurate data — an **intentional improvement** visible immediately in docs. The HTTP routes in `node.server.httpRoutes` and `docs/routes.md` are fixed in Step 5 (consumer migration to `getFacet()`).

## What changes and what doesn't

| | This step | Future step |
|---|---|---|
| `parseRouteMap` in `plugin-tree.ts` | **Kept as-is** (dual-write) | Removed in Step 6 |
| `apiPrefixToOwner` block in `buildPluginTree` | **Kept as-is** | Removed in Step 6 |
| `node.server.httpRoutes` content | Still from `parseRouteMap` (broken) | Fixed in Step 5 via `getFacet()` |
| `node.endpointCallers` content | **Overwritten by `relate()`** ← fix | — |
| `docgen.ts` consumers | **Unchanged** | Migrated to `getFacet()` in Step 5 |
| `tree-handler.ts` | **Unchanged** | Step 5 |

## New type: `RouteDef`

Defined in `plugin-tree.ts` alongside `SlotDef` and `CommandDef`, exported from `plugin-tree/core/index.ts`:

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
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | Add `RouteDef` type; export `walkFiles` |
| `plugins/plugin-meta/plugins/plugin-tree/core/index.ts` | Export `RouteDef`, `walkFiles` |

## Implementation

### `plugins/plugin-meta/plugins/facets/plugins/routes/facet/index.ts`

```ts
import { join } from "path";
import { createFacet, defineFacet, getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import {
  type RouteDef,
  type PluginTree,
  readIfExists,
  stripTypes,
  matchBracket,
  walkFiles,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";

export const routesFacetDef = defineFacet<RouteDef[]>("routes");

export default createFacet<RouteDef[]>({
  def: routesFacetDef,

  extract(ctx) {
    const routes: RouteDef[] = [];

    // ── HTTP routes: parse defineEndpoint({ route: "..." }) from core/**/*.ts ─
    const coreDir = join(ctx.dir, "core");
    const coreFiles: string[] = [];
    walkFiles(coreDir, coreFiles);

    // Map from exported const name → route string
    const endpointRoutes = new Map<string, string>();
    for (const file of coreFiles.filter((f) => f.endsWith(".ts"))) {
      const raw = readIfExists(file);
      if (!raw) continue;
      const src = stripTypes(raw);
      // Match: export const NAME = defineEndpoint(
      const exportRe = /export\s+const\s+(\w+)\s*=\s*defineEndpoint\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = exportRe.exec(src))) {
        const name = m[1]!;
        // The opening '(' of defineEndpoint(...) is at m.index + m[0].length - 1
        const parenStart = m.index + m[0].length - 1;
        const parenEnd = matchBracket(src, parenStart, "(", ")");
        if (parenEnd < 0) continue;
        const body = src.slice(parenStart + 1, parenEnd);
        const routeMatch = /route\s*:\s*"([^"]+)"/.exec(body);
        if (routeMatch) endpointRoutes.set(name, routeMatch[1]!);
      }
    }

    // Determine which endpoints are wired on server vs central
    for (const runtime of ["server", "central"] as const) {
      const barrelPath = join(ctx.dir, runtime, "index.ts");
      const raw = readIfExists(barrelPath);
      if (!raw) continue;
      const src = stripTypes(raw);

      // Find httpRoutes: { ... } block
      const blockIdx = src.search(/\bhttpRoutes\s*:\s*\{/);
      if (blockIdx >= 0) {
        const blockStart = src.indexOf("{", blockIdx);
        const blockEnd = matchBracket(src, blockStart, "{", "}");
        if (blockEnd >= 0) {
          const block = src.slice(blockStart + 1, blockEnd);

          // Computed keys: [endpointName.route] or [endpointName.anything]
          const computedRe = /\[\s*(\w+)\s*\.\s*\w+\s*\]/g;
          let km: RegExpExecArray | null;
          while ((km = computedRe.exec(block))) {
            const routeStr = endpointRoutes.get(km[1]!);
            if (routeStr) routes.push({ route: routeStr, type: "http", runtime, name: km[1]! });
          }

          // Literal string keys (rare legacy routes)
          const literalRe = /"([^"]+)"\s*:/g;
          while ((km = literalRe.exec(block))) {
            routes.push({ route: km[1]!, type: "http", runtime });
          }
        }
      }

      // WS routes: literal keys in wsRoutes: { ... }
      const wsIdx = src.search(/\bwsRoutes\s*:\s*\{/);
      if (wsIdx >= 0) {
        const wsStart = src.indexOf("{", wsIdx);
        const wsEnd = matchBracket(src, wsStart, "{", "}");
        if (wsEnd >= 0) {
          const wsBlock = src.slice(wsStart + 1, wsEnd);
          const keyRe = /"([^"]+)"\s*:/g;
          let km: RegExpExecArray | null;
          while ((km = keyRe.exec(wsBlock))) {
            routes.push({ route: km[1]!, type: "ws", runtime });
          }
        }
      }
    }

    return routes;
  },

  relate(rawCtx) {
    const { tree } = rawCtx as { tree: PluginTree };

    // Build a prefix → owner map using accurate routes from the facet
    // (replaces the broken apiPrefixToOwner built from parseRouteMap results,
    // which missed all [endpoint.route] computed keys)
    const apiPrefixToOwner = new Map<string, (typeof [...tree.byDir.values()])[0]>();
    for (const info of tree.byDir.values()) {
      const routes = getFacet(info, routesFacetDef) ?? [];
      for (const r of routes) {
        if (r.type !== "http") continue;
        const pathMatch = r.route.match(/^\S+\s+\/api\/([A-Za-z0-9_-]+)/);
        if (!pathMatch) continue;
        const prefix = pathMatch[1]!;
        if (!apiPrefixToOwner.has(prefix)) apiPrefixToOwner.set(prefix, info);
      }
    }

    if (apiPrefixToOwner.size === 0) return;

    const prefixes = [...apiPrefixToOwner.keys()];
    const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`\\/api\\/(${escaped.join("|")})(?![A-Za-z0-9_-])`, "g");

    // Clear existing endpointCallers (populated with broken data by buildPluginTree)
    // and repopulate from correct routes
    for (const info of tree.byDir.values()) info.endpointCallers = [];

    for (const caller of tree.byDir.values()) {
      const files: string[] = [];
      for (const sub of ["web", "server", "central"]) {
        walkFiles(join(caller.dir, sub), files);
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
  },

  renderDoc(data, ctx) {
    if (data.length === 0) return [];
    const subIndent = `${ctx.bodyIndent}  `;
    const lines: string[] = [];
    const serverHttp  = data.filter(r => r.runtime === "server"  && r.type === "http");
    const serverWs    = data.filter(r => r.runtime === "server"  && r.type === "ws");
    const centralHttp = data.filter(r => r.runtime === "central" && r.type === "http");
    const centralWs   = data.filter(r => r.runtime === "central" && r.type === "ws");
    if (serverHttp.length > 0 || serverWs.length > 0) {
      lines.push(`${subIndent}- Server routes: ${[
        ...serverHttp.map(r => `\`${r.route}\``),
        ...serverWs.map(r => `\`${r.route} (WS)\``),
      ].join(", ")}`);
    }
    if (centralHttp.length > 0 || centralWs.length > 0) {
      lines.push(`${subIndent}- Central routes: ${[
        ...centralHttp.map(r => `\`${r.route}\``),
        ...centralWs.map(r => `\`${r.route} (WS)\``),
      ].join(", ")}`);
    }
    return lines;
  },
});
```

### `plugin-tree.ts` — minimal additions only

1. **Add `RouteDef` type** (alongside `SlotDef` at line 19):
   ```ts
   export interface RouteDef {
     route: string;
     type: "http" | "ws";
     runtime: "server" | "central";
     name?: string;
   }
   ```

2. **Export `walkFiles`**: change `function walkFiles` to `export function walkFiles`.

Everything else in `plugin-tree.ts` stays untouched — `parseRouteMap`, `apiPrefixToOwner`, `RuntimeDetail.httpRoutes/wsRoutes` all remain (dual-write).

### `plugin-tree/core/index.ts` — add two exports

```ts
export type { RouteDef } from "./internal/plugin-tree";
export { walkFiles } from "./internal/plugin-tree";
```

### `plugins/plugin-meta/plugins/facets/plugins/routes/package.json`

```json
{
  "name": "@singularity/plugin-plugin-meta-facets-routes",
  "version": "0.0.1",
  "private": true
}
```

### `plugins/plugin-meta/plugins/facets/plugins/routes/CLAUDE.md`

```markdown
# routes

Extracts HTTP routes (from `defineEndpoint()` calls in each plugin's `core/`) and WS
routes (literal keys in `server/` and `central/` barrels). Fixes the blindness of the
monolithic `parseRouteMap` which only captured quoted string keys.

`relate()` rewrites `node.endpointCallers` using accurate route data.
No consumer migration yet — `docgen.ts` still reads `node.server.httpRoutes` (Step 5).
```

## walkFiles and directory errors

`walkFiles` in `plugin-tree.ts` currently uses `readdirSync` without a try/catch for missing dirs. The facet calls it on potentially non-existent subdirs (`core/`, `web/`, `server/`, `central/`). Either:
- Export a defensive wrapper that silently returns on ENOENT, or
- Add a try/catch in `walkFiles` itself

The existing `walkFiles` already handles this via try/catch on `readdirSync`. Verify this is in place before relying on it.

## Known limitation: HTTP routes still missing from docs until Step 5

`docgen.ts:renderPluginBody()` still reads `node.server.httpRoutes` (from `parseRouteMap`, which misses computed keys). So the "Server:" section in `plugins-details.md` and per-plugin CLAUDE.md autogen blocks won't show HTTP routes until Step 5 wires `docgen.ts` to use `getFacet(node, routesFacetDef)`.

**What does improve immediately**: `endpointCallers` in docs — plugins will now show correct "Endpoint callers" in their CLAUDE.md autogen blocks and `plugins-details.md`.

## Verification

```bash
# Save baseline before changes
./equin build
cp docs/plugins-details.md /tmp/baseline-details.md

# After implementing the facet
./equin build

# endpointCallers should now populate correctly
# (look for "Endpoint callers" lines that were missing before)
diff /tmp/baseline-details.md docs/plugins-details.md

# All checks must pass
./equin check

# Spot-check: tasks plugin should show endpoint callers
grep -A5 "Endpoint callers" plugins/tasks/CLAUDE.md
```

The diff will show changes in "Endpoint callers" lines — that's the expected improvement. Everything else should be byte-identical (HTTP routes in docs still broken — that's Step 5's job).
