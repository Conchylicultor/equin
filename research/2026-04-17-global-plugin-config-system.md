# Plugin Config System

## Context

Today, plugins hardcode their behavior. The concrete itch: `plugins/stats/plugins/commits/server/internal/commit-timestamps.ts:8-11` hardcodes a set of commit SHAs to exclude from line-change stats. Any plugin that wants a tunable value has to ship code, rebuild, and push.

We want:

- Plugins declare typed, labeled config values with defaults.
- A new **Settings** entry in the System sidebar group (alongside Tasks, Logs, Stats) renders a form, grouped by plugin, for all declared values.
- Changes persist per-worktree, propagate reactively to web subscribers, and are readable by server code.
- As a demo, stats/commits stops hardcoding its filter and reads from config instead.

**Scope decided:** per-worktree — values live in each worktree's DB, inherited from main on `pg_dump` fork (consistent with `server/CLAUDE.md:174`). UI is auto-rendered from specs for v1; no custom section slot.

## New plugin: `plugins/config/`

Root plugin with `shared/`, `server/`, `web/`.

### `plugins/config/shared/index.ts`

Typed spec + factory. Registration happens at module import time (safe — no DB touched yet).

```ts
export type ConfigType<T = unknown> =
  | { kind: "string"; default: string }
  | { kind: "number"; default: number }
  | { kind: "boolean"; default: boolean }
  | { kind: "string-list"; default: string[] };

export interface ConfigSpec<T = unknown> {
  pluginId: string;           // "stats-commits"
  pluginName: string;         // "Stats: Commits"  (rendered as group title)
  key: string;                // local key, e.g. "excluded-shas" — no dots
  fullKey: string;            // "stats-commits.excluded-shas" — DB PK
  label: string;
  description?: string;
  type: ConfigType<T>;
  validate?: (v: T) => string | null;   // escape hatch; returns error msg or null
  // scope is documented but only "shared-via-fork" supported in v1.
  // Future values may need scope: "worktree-only" (not inherited on fork) for secrets.
  scope?: "shared-via-fork";
}

export function defineConfig<T>(spec: Omit<ConfigSpec<T>, "fullKey">): ConfigSpec<T>;
```

`defineConfig` asserts `key` has no `.` and pushes the spec into a module-level `allSpecs: ConfigSpec[]`. A duplicate `fullKey` throws. The `shared` module exports `getRegisteredSpecs()` so both web and server can read it.

### `plugins/config/server/`

**Schema** (`schema.ts`):

```ts
export const config = pgTable("config", {
  key: text("key").primaryKey(),           // full key: "<pluginId>.<localKey>"
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

Add export line to `server/src/db/schema.ts` barrel.

**Resource** (`internal/resource.ts`):

- `configResource = defineResource({ key: "config", mode: "push", loader })`.
- `loader()` reads all rows from `config`, returns `{ [fullKey]: value }`.
- The loader must tolerate rows whose spec has been removed — it returns them in the map; the UI hides them (and surfaces a "Remove stale" affordance; v1 can just hide).

**Server-side read cache** (`internal/read-cache.ts`):

Don't rely on the resource machinery — `defineResource` re-runs the loader on every `load()` (`server/src/resources.ts`). Maintain a small `Map<string, unknown>` alongside the resource. Populate on loader run. Invalidate on PATCH. `readConfig(spec)` returns `cache.get(spec.fullKey) ?? spec.type.default`.

**Public API** (`api.ts`):

```ts
export { configResource } from "./internal/resource";
export function readConfig<T>(spec: ConfigSpec<T>): Promise<T>;  // uses cache, fills from DB on miss
export function registerConfigSpec(spec: ConfigSpec): void;      // thin re-export of shared `defineConfig` registration
```

Same pattern as `Runtime.register` (see `plugins/conversations/plugins/runtime-tmux/server/index.ts`). Plugins that read config import from `@plugins/config/server/api`.

**Routes** (`internal/handlers.ts`):

- `GET /api/config` — returns `{ specs: ConfigSpec[], values: { [fullKey]: unknown } }`. Used by Settings pane to render the form (alternative to useResource; we'll actually use the resource for values and call a separate `GET /api/config/specs` for specs list, see below).
- `PATCH /api/config` — body `{ key, value }`. Validates: spec must exist; value must match `spec.type.kind` and pass `spec.validate`. Upserts. Calls `configResource.notify()`. Clears read-cache entry.
- `DELETE /api/config/:key` — removes a row (reset to default).

Actually, simplification: the specs list is static (determined by which server plugins are loaded), so expose a single resource-agnostic endpoint `GET /api/config/specs` returning `ConfigSpec[]`, and use `configResource` for values. Web fetches specs once; values are live.

**Index** (`index.ts`):

```ts
const plugin: ServerPluginDefinition = {
  id: "config",
  name: "Config",
  httpRoutes: { /* ... */ },
  resources: [configResource],
  onReady: async () => { await primeReadCache(); },  // optional warm-up
};
```

Register in `server/src/plugins.ts` early enough that dependents (e.g. stats-commits) can call `readConfig` after `onReady`.

### `plugins/config/web/`

**Slots** (`slots.ts`):

```ts
export const Config = {
  Spec: defineSlot<{ spec: ConfigSpec }>("config.spec"),
};
```

Plugins contribute `Config.Spec({ spec: mySpec })`.

**Plugin def** (`index.ts`):

```ts
const configPlugin: PluginDefinition = {
  id: "config",
  name: "Settings",
  contributions: [
    Shell.Sidebar({ title: "Settings", icon: MdSettings, group: "System",
      onClick: () => ShellCommands.OpenPane(settingsPane()) }),
    Shell.Route({ pattern: "/settings", resolve: () => settingsPane() }),
  ],
};
```

Register in `web/src/plugins.ts`. Add `MdSettings` to the `SIDEBAR_GROUPS` map rendering if the System group's icon needs adjusting (currently `MdTune`; leaving it alone is fine).

**Views** (`views.tsx`):

`settingsPane()` returns a `PaneDescriptor` rendering `SettingsPanel`.

**Components** (`components/settings-panel.tsx`):

1. `const contributions = Config.Spec.useContributions()` — collect specs from all plugins.
2. `const { data: values } = useResource(configResource)` — live values.
3. Group specs by `pluginId`, sort by `pluginName`, render one `<SettingsGroup>` per plugin.
4. Per spec, render a field:
   - `string` → shadcn `Input`
   - `number` → `Input type="number"`
   - `boolean` → shadcn `Switch`
   - `string-list` → `Textarea` (one per line). Normalize on write: trim lines, drop empty, dedupe.
5. Each field is a controlled component that fetches via `PATCH /api/config` on debounced change (300ms). Use local state while editing; reconcile from resource on blur or when `version` differs and field is unfocused — do NOT overwrite the user's in-progress input from the push.
6. If a `fullKey` exists in values with no matching spec, skip it in the UI (stale).

**Hooks** (`api.ts`):

```ts
export function useConfigValue<T>(spec: ConfigSpec<T>): T;   // read-only
export async function setConfigValue<T>(spec: ConfigSpec<T>, value: T): Promise<void>;
```

`useConfigValue` wraps `useResource(configResource)` and returns `values[spec.fullKey] ?? spec.type.default`. Read-only hook + imperative setter keeps writes auditable to the Settings pane.

## Demo wire-up: stats/commits

### Declare the spec

New file `plugins/stats/plugins/commits/shared/config.ts`:

```ts
import { defineConfig } from "@plugins/config/shared";

export const excludedShasConfig = defineConfig<string[]>({
  pluginId: "stats-commits",
  pluginName: "Stats: Commits",
  key: "excluded-shas",
  label: "Excluded commit SHAs",
  description:
    "Commits excluded from line-change aggregation. Distortion fix for bulk refactor commits.",
  type: {
    kind: "string-list",
    default: [
      "983277b35b866c200cbee400383fdee63368d7e8",
      "ea912679590b69ad437396232d2a5707ca27e53d",
    ],
  },
});
```

### Web contribution

`plugins/stats/plugins/commits/web/index.ts` — add:

```ts
import { Config as ConfigSlots } from "@plugins/config/web/slots";
import { excludedShasConfig } from "../shared/config";
// ...
contributions: [
  // ...existing chart contributions
  ConfigSlots.Spec({ spec: excludedShasConfig }),
],
```

### Server consumption

`plugins/stats/plugins/commits/server/index.ts` — register the spec so the server-side registry sees it:

```ts
import { registerConfigSpec } from "@plugins/config/server/api";
import { excludedShasConfig } from "../shared/config";

registerConfigSpec(excludedShasConfig);
```

### Remove hardcode + pass filter through handlers

In `plugins/stats/plugins/commits/server/internal/commit-timestamps.ts`:

- Delete `LINE_STATS_EXCLUDED_SHAS` constant (lines 6-11).
- Change `CommitInfo` to carry `sha` alongside iso/added/removed so handlers can filter after fetch.
- `getCommits()` returns raw per-commit line counts; 30s TTL cache remains valid because it's now config-independent.

In `handle-cumulative.ts` and `handle-rate.ts`:

- Call `const excluded = new Set(await readConfig(excludedShasConfig));` at the top of each line-stats handler.
- When accumulating `added/removed`, skip commits where `excluded.has(c.sha)`.
- Commits-count handlers don't need the filter (current behavior preserved).

## Registration + import ordering

Avoid the migration-runner race (`server/src/index.ts:10-12` warns about import-time DB calls):

- `defineConfig`/`registerConfigSpec` only mutate in-memory arrays — no DB.
- The `config` resource `loader` hits the DB only when first subscribed, which happens after migrations.
- `readConfig` lazily loads the cache on first call, after migrations.

Order in `server/src/plugins.ts`: place `configPlugin` before `statsCommitsPlugin` so `readConfig` finds a primed cache.

## Verification

1. `./equin build` — triggers `drizzle-kit generate` (creates migration for `config` table), rebuilds web + server, restarts.
2. Open `http://<worktree>.localhost:9000` (clickable).
3. Click **Settings** in the System sidebar group → page renders with "Stats: Commits" section containing "Excluded commit SHAs" textarea prefilled with the two default SHAs.
4. Remove one SHA, wait 300ms → PATCH fires → resource notifies → reload Stats page → "Lines changed over time" chart now includes that commit's line delta.
5. Open a second browser tab on Settings → edit value in tab A → tab B's value updates live (push notification path).
6. Delete the custom value (reset) → defaults restore.
7. `./equin check` passes (no migration drift).
8. On a fresh worktree fork (`./equin push` then new worktree), the config table and values inherit from main — Settings page shows the same state as main had at fork time.

Edge-case smoke checks:

- Empty textarea → saves `[]` → all commits included.
- Whitespace-only line → normalized out.
- Duplicate lines → deduped.
- Tab A typing while tab B pushes an update → tab A's current input not clobbered.

## Critical files

**New:**
- `plugins/config/shared/index.ts`
- `plugins/config/server/{index.ts,api.ts,schema.ts,internal/{resource.ts,read-cache.ts,handlers.ts}}`
- `plugins/config/web/{index.ts,slots.ts,views.tsx,api.ts,components/{settings-panel.tsx,settings-group.tsx,field.tsx}}`
- `plugins/stats/plugins/commits/shared/config.ts`

**Modified:**
- `server/src/db/schema.ts` — add `export * from "@plugins/config/server/schema";`
- `server/src/plugins.ts` — register `configPlugin` before `statsCommitsPlugin`
- `web/src/plugins.ts` — register `configPlugin`
- `plugins/stats/plugins/commits/web/index.ts` — add `Config.Spec` contribution
- `plugins/stats/plugins/commits/server/index.ts` — call `registerConfigSpec`
- `plugins/stats/plugins/commits/server/internal/commit-timestamps.ts` — drop hardcoded set, carry sha on CommitInfo
- `plugins/stats/plugins/commits/server/internal/handle-cumulative.ts` — apply filter via `readConfig`
- `plugins/stats/plugins/commits/server/internal/handle-rate.ts` — apply filter via `readConfig`
- `docs/plugins.md` — document new `config` plugin + `Config.Spec` slot

**Reused / referenced:**
- `plugin-core/use-resource.ts:70` (`useResource`)
- `server/src/resources.ts` (`defineResource`, `notify`, `dependsOn`)
- `plugins/shell/web/slots.ts` (`Shell.Sidebar`, `Shell.Route`)
- `plugins/shell/web/commands.ts` (`Shell.OpenPane`)
- `plugins/conversations/plugins/runtime-tmux/server/index.ts` (imperative-registry pattern precedent)
- `web/src/components/ui/{input,switch,textarea}.tsx` (form primitives — textarea may need `bunx shadcn@latest add textarea` from `web/`)
