# Community Browser Server Endpoints

## Context

The tweakcn community-browser sub-plugin (`plugins/ui/plugins/tweakcn/plugins/community-browser/`) currently has only a `shared/` layer: `CatalogTheme` type and a bundled `catalog.json` (~521 themes from tweakcn registry + community). The web UI (future step) needs two server endpoints to browse and apply themes. This task adds the `core/` and `server/` layers.

No new DB tables — the apply endpoint upserts into the parent plugin's existing `tweakcn_themes` table using the same pattern as `handle-import.ts`.

## Files to modify

### 1. Parent `core/index.ts` — re-export `convertTweakcnTheme`

**File:** `plugins/ui/plugins/tweakcn/core/index.ts`

The sub-plugin's server needs `convertTweakcnTheme` from the parent's `shared/convert.ts`. Since `shared/` is plugin-private (cross-plugin imports forbidden), re-export it through the `core/` barrel so the sub-plugin can import from `@plugins/ui/plugins/tweakcn/core`.

```ts
export { convertTweakcnTheme } from "../shared/convert";
```

### 2. Parent `server/index.ts` — export `_tweakcnThemes` table

**File:** `plugins/ui/plugins/tweakcn/server/index.ts`

The sub-plugin's apply handler needs to upsert into `_tweakcnThemes`. Add a named export:

```ts
export { _tweakcnThemes } from "./internal/tables";
```

## Files to create

### 3. `core/endpoints.ts` — endpoint definitions + Zod schemas

**File:** `plugins/ui/plugins/tweakcn/plugins/community-browser/core/endpoints.ts`

Two endpoints:

```ts
import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { TweakcnThemeSchema } from "@plugins/ui/plugins/tweakcn/core";

const CatalogThemeSchema = z.object({
  id: z.string(),
  name: z.string(),
  tags: z.array(z.string()),
  source: z.enum(["registry", "community"]),
  likeCount: z.number().optional(),
  author: z.string().optional(),
  cssVars: z.object({
    theme: z.record(z.string(), z.string()),
    light: z.record(z.string(), z.string()),
    dark: z.record(z.string(), z.string()),
  }),
});

export const getCatalog = defineEndpoint({
  route: "GET /api/tweakcn/community/catalog",
  response: z.object({ themes: z.array(CatalogThemeSchema) }),
});

export const applyCatalogTheme = defineEndpoint({
  route: "POST /api/tweakcn/community/apply",
  body: z.object({ themeId: z.string() }),
  response: TweakcnThemeSchema,
});
```

### 4. `core/index.ts` — barrel

**File:** `plugins/ui/plugins/tweakcn/plugins/community-browser/core/index.ts`

```ts
export { getCatalog, applyCatalogTheme } from "./endpoints";
```

### 5. `server/internal/handle-get-catalog.ts` — GET handler

**File:** `plugins/ui/plugins/tweakcn/plugins/community-browser/server/internal/handle-get-catalog.ts`

Reads the bundled `catalog.json` from `shared/` (same plugin, so intra-plugin import is fine) and returns it wrapped in `{ themes }`.

```ts
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { getCatalog } from "../../core/endpoints";
import catalog from "../../shared/catalog.json";
import type { CatalogTheme } from "../../shared/types";

export const handleGetCatalog = implement(getCatalog, async () => {
  return { themes: catalog as CatalogTheme[] };
});
```

### 6. `server/internal/handle-apply.ts` — POST handler

**File:** `plugins/ui/plugins/tweakcn/plugins/community-browser/server/internal/handle-apply.ts`

Mirrors the parent's `handle-import.ts` pattern but looks up in the catalog instead of fetching from tweakcn.com.

```ts
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { convertTweakcnTheme } from "@plugins/ui/plugins/tweakcn/core";
import { _tweakcnThemes } from "@plugins/ui/plugins/tweakcn/server";
import { applyCatalogTheme } from "../../core/endpoints";
import catalog from "../../shared/catalog.json";
import type { CatalogTheme } from "../../shared/types";

export const handleApply = implement(applyCatalogTheme, async ({ body }) => {
  const { themeId } = body;
  const theme = (catalog as CatalogTheme[]).find((t) => t.id === themeId);
  if (!theme) {
    throw new HttpError(404, `Theme "${themeId}" not found in catalog`);
  }

  const presets = convertTweakcnTheme(theme.cssVars);
  const id = crypto.randomUUID();
  const now = new Date();

  await db
    .insert(_tweakcnThemes)
    .values({
      id,
      tweakcnId: theme.id,
      label: theme.name,
      rawJson: theme.cssVars as Record<string, unknown>,
      presets,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: _tweakcnThemes.tweakcnId,
      set: {
        label: theme.name,
        rawJson: theme.cssVars as Record<string, unknown>,
        presets,
      },
    });

  const [row] = await db
    .select()
    .from(_tweakcnThemes)
    .where(eq(_tweakcnThemes.tweakcnId, theme.id))
    .limit(1);

  if (!row) throw new HttpError(500, "Failed to read back inserted theme");

  return {
    id: row.id,
    tweakcnId: row.tweakcnId,
    label: row.label,
    presets: row.presets,
    createdAt: row.createdAt.toISOString(),
  };
});
```

### 7. `server/index.ts` — ServerPluginDefinition barrel

**File:** `plugins/ui/plugins/tweakcn/plugins/community-browser/server/index.ts`

```ts
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { getCatalog, applyCatalogTheme } from "../core/endpoints";
import { handleGetCatalog } from "./internal/handle-get-catalog";
import { handleApply } from "./internal/handle-apply";

export default {
  id: "ui-tweakcn-community-browser",
  name: "UI: Tweakcn Community Browser",
  description: "Community theme catalog and apply endpoints for tweakcn.",
  httpRoutes: {
    [getCatalog.route]: handleGetCatalog,
    [applyCatalogTheme.route]: handleApply,
  },
} satisfies ServerPluginDefinition;
```

## Verification

After `./equin build`:

```bash
# GET catalog — should return { themes: [...] } with ~521 entries
curl -s http://att-1779734016-06cx.localhost:9000/api/tweakcn/community/catalog | jq '.themes | length'

# Apply a registry theme (e.g. "catppuccin") — should return a TweakcnTheme object
curl -s -X POST http://att-1779734016-06cx.localhost:9000/api/tweakcn/community/apply \
  -H 'Content-Type: application/json' \
  -d '{"themeId":"catppuccin"}' | jq .

# Verify it landed in the DB
curl -s http://att-1779734016-06cx.localhost:9000/api/tweakcn/themes | jq '.[0].tweakcnId'
```
