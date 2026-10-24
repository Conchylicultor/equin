# Plugin Config System (v2)

Supersedes v1. Same architecture (new `config` plugin, `Settings` sidebar pane, per-worktree DB table, push-resource for live updates). **Changes the plugin-facing API** to remove per-field boilerplate — plugins declare one typed object and the framework fills in the rest.

## Context (why v2)

v1 asked plugins to repeat their identity and label every field by hand:

```ts
defineConfig<string[]>({
  pluginId: "stats-commits",         // already in the plugin def
  pluginName: "Stats: Commits",      // already in the plugin def
  key: "excluded-shas",
  label: "Excluded commit SHAs",     // derivable from key
  type: { kind: "string-list", default: [...] },   // kind derivable from typeof default
});
```

Everything bold was derivable. v2 derives it.

## Plugin-facing API

### Declaration

One object per plugin, keyed by field name. Defaults drive type inference and form rendering.

```ts
// plugins/stats/plugins/commits/shared/config.ts
import { defineConfig } from "@plugins/config/shared";

export const commitsConfig = defineConfig({
  excludedShas: {
    default: [
      "983277b35b866c200cbee400383fdee63368d7e8",
      "ea912679590b69ad437396232d2a5707ca27e53d",
    ],
    description: "Commits excluded from line-change aggregation.",
  },
});
```

Short form for fields that don't need metadata — the value IS the default:

```ts
export const debugConfig = defineConfig({
  debug: false,
  maxRetries: 3,
  apiKey: "",
});
```

Mixed is fine:

```ts
export const uiConfig = defineConfig({
  debug: false,
  excludedShas: { default: [...], description: "..." },
});
```

### Contribution (web)

```ts
// plugins/stats/plugins/commits/web/index.ts
contributions: [
  ConfigSlots.Spec(commitsConfig),   // framework annotates with parent plugin id/name
],
```

No `{ spec: commitsConfig }` wrapper — `Config.Spec` is defined as `defineSlot<ConfigSchema>("config.spec")` so the descriptor goes through directly.

### Registration (server)

Symmetric to slots: add a `config?` field to `ServerPluginDefinition`.

```ts
// plugins/stats/plugins/commits/server/index.ts
import { commitsConfig } from "../shared/config";

const plugin: ServerPluginDefinition = {
  id: "stats-commits",
  name: "Stats: Commits",
  config: commitsConfig,
  httpRoutes: { ... },
};
```

The config plugin's `onReady` iterates `plugins.filter(p => p.config)` and indexes them by plugin id — no imperative `registerConfigSpec(...)` calls.

### Reading values

Both sides return a fully-typed object:

```ts
// Server
const { excludedShas } = await readConfig(commitsConfig);   // excludedShas: string[]

// Web
const { excludedShas } = useConfigValues(commitsConfig);    // excludedShas: string[]
```

Writing (Settings pane only):

```ts
await setConfigValues(commitsConfig, { excludedShas: [...] });   // partial allowed
```

## Type inference

```ts
type FieldMeta<T> = { default: T; description?: string; label?: string };

// Each field is either a plain default OR an object with metadata
type Field<T = unknown> = T | FieldMeta<T>;

type Schema = Record<string, Field>;

type ValueOf<F> = F extends FieldMeta<infer T> ? T : F;

type Values<S extends Schema> = { [K in keyof S]: ValueOf<S[K]> };

export interface ConfigDescriptor<S extends Schema = Schema> {
  schema: S;   // normalized internally to { [K]: FieldMeta<T> }
  // Phantom for inference
  readonly __values?: Values<S>;
}

export function defineConfig<const S extends Schema>(schema: S): ConfigDescriptor<S>;
```

`readConfig` / `useConfigValues` return `Values<S>` — TS infers `{ excludedShas: string[] }` from the default literal.

**Edge case — ambiguous defaults.** `default: []` infers as `never[]`. Mitigations:
- Require `as const` or `as string[]` at the call site: `default: [] as string[]`.
- Or use the long form with an explicit TS type argument when needed: `defineConfig({ tags: { default: [] as string[] } })`.

For v1, document this and leave it. All realistic defaults (including the demo) are unambiguous.

## Framework changes

### 1. PluginProvider annotates contributions (`plugin-core/context.tsx`)

Currently flatMap drops the plugin reference. Change to annotate each contribution with parent plugin metadata before storing:

```ts
const contributions = plugins.flatMap((p) =>
  (p.contributions ?? []).map((c) => ({
    ...c,
    _pluginId: p.id,
    _pluginName: p.name,
    _pluginDescription: p.description,
  })),
);
```

`Contribution` type gains the three underscore-prefixed optional fields.

`defineSlot`'s `useContributions` already strips `_slotId` via rest destructuring — leave it stripping only `_slotId` (framework-added `_pluginId` etc. pass through to consumers who need them, invisible to those who don't since the slot props type doesn't include them).

Most consumers ignore the annotations. The Settings pane uses them to label groups.

### 2. Settings UI reads annotated contributions

```ts
// plugins/config/web/components/settings-panel.tsx
const raw = useContext(PluginRuntimeContext)!.bySlot.get("config.spec") ?? [];
// Each entry: { _slotId, _pluginId, _pluginName, _pluginDescription, schema, __values? }
```

Group by `_pluginId`, render one section per plugin using `_pluginName` as the header.

Small helper `Config.Spec.useContributionsWithPlugin()` exported from `@plugins/config/web/slots` keeps this tidy — no consumer boilerplate.

### 3. `ServerPluginDefinition.config?` (`server/src/types.ts`)

Add:

```ts
config?: ConfigDescriptor;
```

The `config` server plugin's `onReady` walks the plugin registry, builds a map of `pluginId → { descriptor, pluginName }`, and uses it for: defaults, spec validation on PATCH, and the `GET /api/config/specs` response.

## Demo: stats/commits (v2)

Unchanged from v1 in behavior. Only the declaration is simpler.

```ts
// plugins/stats/plugins/commits/shared/config.ts
import { defineConfig } from "@plugins/config/shared";

export const commitsConfig = defineConfig({
  excludedShas: {
    default: [
      "983277b35b866c200cbee400383fdee63368d7e8",
      "ea912679590b69ad437396232d2a5707ca27e53d",
    ],
    description: "Commits excluded from line-change aggregation.",
  },
});
```

```ts
// plugins/stats/plugins/commits/web/index.ts
import { Config as ConfigSlots } from "@plugins/config/web/slots";
import { commitsConfig } from "../shared/config";

contributions: [
  // ...existing Stats.Chart contributions
  ConfigSlots.Spec(commitsConfig),
],
```

```ts
// plugins/stats/plugins/commits/server/index.ts
import { commitsConfig } from "../shared/config";

const plugin: ServerPluginDefinition = {
  id: "stats-commits",
  name: "Stats: Commits",
  config: commitsConfig,
  httpRoutes: { ... },
};
```

```ts
// plugins/stats/plugins/commits/server/internal/handle-cumulative.ts
import { readConfig } from "@plugins/config/server/api";
import { commitsConfig } from "../../shared/config";

export async function handleLinesCumulative(): Promise<Response> {
  const { excludedShas } = await readConfig(commitsConfig);
  const excluded = new Set(excludedShas);
  const commits = await getCommits();   // now returns raw {sha, iso, added, removed}
  // ... accumulate, skipping lines for commits in `excluded`
}
```

## Form rendering

`inputKindOf(value)` inferred from `typeof default`:

| typeof default                              | input          |
|---------------------------------------------|----------------|
| `string`                                    | `Input`        |
| `number`                                    | `Input[number]`|
| `boolean`                                   | `Switch`       |
| `Array<string>`                             | `Textarea` (one per line; trim/drop-empty/dedupe on write) |
| anything else                               | render as "unsupported field type" placeholder, log once |

Label derivation: camelCase → sentence case. `excludedShas` → `"Excluded shas"`. Override with `label: "Excluded SHAs"` when needed.

## Unchanged from v1

- Scope: per-worktree. DB table `config(key TEXT PK, value JSONB, updated_at)` in `plugins/config/server/schema.ts`. Full key is `<pluginId>.<fieldName>`.
- Resource: single `configResource` (push, all values in one payload).
- Server read-cache invalidated on PATCH (don't rely on resource loader for per-request reads).
- Stale keys (spec removed): returned by loader, hidden in UI, `readConfig` falls back to default.
- Push-during-edit: compare versions or track focus so active input isn't clobbered.
- Ordering: `configPlugin` before `statsCommitsPlugin` in `server/src/plugins.ts`.
- No zod. Validation of inbound PATCH is a simple `typeof` / `Array.isArray` switch against the inferred kind.

## Files

**New:**
- `plugins/config/shared/index.ts` — `defineConfig`, types
- `plugins/config/server/{index.ts,api.ts,schema.ts,internal/{resource.ts,read-cache.ts,handlers.ts}}`
- `plugins/config/web/{index.ts,slots.ts,views.tsx,api.ts,components/{settings-panel.tsx,settings-group.tsx,field.tsx}}`
- `plugins/stats/plugins/commits/shared/config.ts`

**Modified:**
- `plugin-core/types.ts` — annotate `Contribution` with optional `_pluginId`, `_pluginName`, `_pluginDescription`
- `plugin-core/context.tsx` — PluginProvider injects those fields
- `server/src/types.ts` — add `config?: ConfigDescriptor` to `ServerPluginDefinition`
- `server/src/db/schema.ts` — barrel export config schema
- `server/src/plugins.ts` — register `configPlugin` before `statsCommitsPlugin`
- `web/src/plugins.ts` — register `configPlugin`
- `plugins/stats/plugins/commits/web/index.ts` — `ConfigSlots.Spec(commitsConfig)`
- `plugins/stats/plugins/commits/server/index.ts` — `config: commitsConfig`
- `plugins/stats/plugins/commits/server/internal/commit-timestamps.ts` — drop hardcoded set, carry `sha` on `CommitInfo`
- `plugins/stats/plugins/commits/server/internal/{handle-cumulative,handle-rate}.ts` — apply filter via `readConfig`
- `docs/plugins.md` — document `config` plugin + `Config.Spec` slot

## Verification

Same as v1:

1. `./equin build` — generates migration for `config` table, rebuilds, restarts.
2. Open `http://<worktree>.localhost:9000` → click Settings → "Stats: Commits" section shows "Excluded shas" textarea with the 2 default SHAs.
3. Remove one SHA → debounced PATCH → `configResource` push → Stats charts reflect the new filter within 30s (cache TTL).
4. Two tabs: edit in A → B updates live; active input in A not overwritten by its own echo.
5. Empty/whitespace/duplicate lines in textarea normalized.
6. `./equin check` passes.
7. Fresh worktree fork inherits whatever main's config table holds at fork time.
