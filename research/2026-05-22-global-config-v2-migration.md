# config_v2 migration: move consumers from DB-backed config to JSONC

## Context

The old `config` plugin stores per-worktree settings in a Postgres table (`config(key, value, updated_at)`). The new `config_v2` plugin stores typed config as JSONC files on disk with a three-layer model (code defaults → git config → user config), conflict detection, and a richer field type system. All consumers of the old `defineConfig`/`useConfig` from `@plugins/config/core` need to be migrated to config_v2's field-based API. This plan covers updating consumer code AND implementing a one-time data migration that reads existing DB values and writes them as config_v2 user override JSONC files.

## Field type audit

Available config_v2 field types vs. what consumers need:

| Old config kind | config_v2 field | Consumers | Status |
|---|---|---|---|
| `boolean` | `boolField` | enabled, singularityOnly | Ready |
| `string` | `textField` | preset, variant, globalPreset | Ready |
| `number` (int) | `intField` | periodicIntervalHours, keepLast, hueShift | Ready |
| `number` (float) | `floatField` | saturationScale, lightnessScale | Ready |
| `string` (JSON blob `"{}"`) | **No exact match** | overrides, params (6 token plugins) | **Deferred** |

All consumers in scope use only `bool`, `string`, `int`, or `float` — existing field types cover everything.

## Scope

### In scope (8 plugin configs)

**Simple consumers** (pure config fields, no cross-plugin coupling):
1. `backup` — `periodicIntervalHours`
2. `backup/local` — `enabled`, `keepLast`
3. `backup/google-drive` — `enabled`, `keepLast`
4. `turn-summary` — `enabled`
5. `stats/cost` — `singularityOnly`

**UI consumers** (no JSON blob fields, no `TokenGroup` slot coupling):
6. `theme-engine` — `globalPreset`
7. `segmented-progress-bar` — `variant`
8. `tokens/color-adjust` — `preset`, `hueShift`, `saturationScale`, `lightnessScale`

### Out of scope

- **Token group plugins with JSON blobs** (deferred): `tokens/shape`, `tokens/sidebar-palette`, `tokens/shadow`, `tokens/chart`, `tokens/color-palette`, `tokens/typography` — their `overrides`/`params` fields store `Record<string, string>` as JSON strings. Needs a new `jsonField` type or similar. Deferred with the `ThemeEngine.TokenGroup` slot interface update.
- **Config.Section consumers** (deferred): `theme-customizer`, `launch-prompts`, `prompt-templates`, `code-review`, `stats/commits`.
- **Auth** (deferred): `auth/google`, `auth/notion`, `auth/central/global-config.ts` — use `secret: true` fields.
- **Old config plugin removal** (deferred): Can't remove until all consumers are migrated. The plugin stays around for its `Config.Section` slot, secret field support, and token group plugin configs.

## Phase 1: Infrastructure

### 1.1 Add `useSetConfig` hook to `@plugins/config_v2/web`

Consumers that write config values outside the Settings pane (token pickers, cost scope toggle) need a write helper. Currently they call `setConfigValue(fullKey, value)` from old config. config_v2's write endpoint needs a `storePath`.

New file: `plugins/config_v2/web/internal/use-set-config.ts`

```ts
export function useSetConfig<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
): (key: keyof F & string, value: unknown) => void {
  const ctx = useContext(PluginRuntimeContext);
  const registrations = ctx.bySlot.get("config-v2.web-register") ?? [];
  const reg = registrations.find((c) => c.descriptor === descriptor);
  const storePath = reg?._hierarchyPath
    ? `${reg._hierarchyPath}/${descriptor.name}.jsonc`
    : null;

  return useCallback((key, value) => {
    if (!storePath) throw new Error("descriptor not registered");
    void fetchEndpoint(setConfigField, {}, { body: { storePath, key, value } });
  }, [storePath]);
}
```

Export from `plugins/config_v2/web/index.ts`.

## Phase 2: Simple consumers

Each migration follows the same pattern:

### Per-consumer recipe

**1. Rewrite `shared/config.ts`** (or `core/config.ts`):
```ts
// Old
import { defineConfig } from "@plugins/config/core";
export const myConfig = defineConfig({ enabled: { default: true, label: "..." } });

// New
import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/config_v2/plugins/fields/plugins/primitives/core";
export const myConfig = defineConfig({
  fields: { enabled: boolField({ label: "...", default: true }) },
});
```

**2. Update `server/index.ts`**:
- Replace `Config.Field(myConfig)` contribution with `ConfigV2.Register({ descriptor: myConfig })`
- Replace `import { Config } from "@plugins/config/server"` with `import { ConfigV2 } from "@plugins/config_v2/server"`
- Replace `await readConfig(myConfig)` with `getConfig(myConfig)` (synchronous — drop `await`)

**3. Update `web/index.ts`**:
- Replace `Config.Spec(myConfig)` contribution with `ConfigV2.WebRegister({ descriptor: myConfig })`
- Replace `import { Config } from "@plugins/config/web"` with `import { ConfigV2 } from "@plugins/config_v2/web"`

**4. Update web component files**:
- Replace `useConfigValues(myConfig, "plugin-id")` with `useConfig(myConfig)` (no pluginId needed)
- Replace `setConfigValue("plugin-id.fieldName", value)` with the `useSetConfig` hook

### 2.1 `plugins/backup` — `periodicIntervalHours`

| Field | Old | New |
|---|---|---|
| `periodicIntervalHours` | `{ default: 24, label: "...", description: "..." }` | `intField({ default: 24, label: "...", description: "..." })` |

Files:
- `plugins/backup/shared/config.ts` — rewrite defineConfig
- `plugins/backup/server/index.ts` — `Config.Field` → `ConfigV2.Register`; `readConfig` → `getConfig`
- `plugins/backup/server/internal/backup-job.ts` — `await readConfig(...)` → `getConfig(...)` (drop await)
- `plugins/backup/web/index.ts` — add `ConfigV2.WebRegister` (check if web barrel exists; if not, create minimal one)

### 2.2 `plugins/backup/plugins/local` — `enabled`, `keepLast`

| Field | New |
|---|---|
| `enabled` | `boolField({ default: true, label: "Enable local backup" })` |
| `keepLast` | `intField({ default: 10, label: "Keep last N...", description: "..." })` |

Files:
- `plugins/backup/plugins/local/shared/config.ts`
- `plugins/backup/plugins/local/server/index.ts` — `Config.Field` → `ConfigV2.Register`
- `plugins/backup/plugins/local/server/internal/run-local-target.ts` — `readConfig` → `getConfig`
- `plugins/backup/plugins/local/web/index.ts` — `Config.Spec` → `ConfigV2.WebRegister`

### 2.3 `plugins/backup/plugins/google-drive` — `enabled`, `keepLast`

Same pattern as local. Files:
- `plugins/backup/plugins/google-drive/shared/config.ts`
- `plugins/backup/plugins/google-drive/server/index.ts`
- `plugins/backup/plugins/google-drive/server/internal/run-target.ts` — `readConfig` → `getConfig`
- `plugins/backup/plugins/google-drive/web/index.ts`

### 2.4 `plugins/conversations/.../turn-summary` — `enabled`

| Field | New |
|---|---|
| `enabled` | `boolField({ default: true, label: "Turn summaries", description: "..." })` |

Files:
- `plugins/conversations/plugins/conversation-view/plugins/turn-summary/shared/config.ts`
- `.../turn-summary/server/index.ts` — `Config.Field` → `ConfigV2.Register`
- `.../turn-summary/server/internal/job.ts` — `readConfig` → `getConfig`
- `.../turn-summary/web/index.ts` — `Config.Spec` → `ConfigV2.WebRegister`

### 2.5 `plugins/stats/plugins/cost` — `singularityOnly`

| Field | New |
|---|---|
| `singularityOnly` | `boolField({ default: true, label: "...", description: "..." })` |

Files:
- `plugins/stats/plugins/cost/shared/config.ts`
- `plugins/stats/plugins/cost/server/index.ts` — `Config.Field` → `ConfigV2.Register`
- `plugins/stats/plugins/cost/web/index.ts` — `Config.Spec` → `ConfigV2.WebRegister`
- `plugins/stats/plugins/cost/web/components/use-scope.ts` — `useConfigValues` → `useConfig`; `setConfigValue` → `useSetConfig` hook

## Phase 3: UI plugins

### 3.1 `plugins/ui/plugins/theme-engine` — `globalPreset`

| Field | New |
|---|---|
| `globalPreset` | `textField({ default: "default", label: "Theme" })` |

Files:
- `plugins/ui/plugins/theme-engine/core/config.ts` (or `shared/config.ts`) — rewrite defineConfig
- `plugins/ui/plugins/theme-engine/server/index.ts` — `Config.Field` → `ConfigV2.Register`
- `plugins/ui/plugins/theme-engine/web/index.ts` — add `ConfigV2.WebRegister`

Note: `theme-customizer` reads `themeEngineConfig` via `useConfigValues` and writes via `setConfigValue`. After migration, update those calls to `useConfig`/`useSetConfig`. Its `Config.Section(...)` contribution stays on old config — that's just a UI mount point.

Files that also need updating in theme-customizer:
- `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer.tsx` — `useConfigValues(themeEngineConfig, PLUGIN_ID)` → `useConfig(themeEngineConfig)`; `setConfigValue(\`${PLUGIN_ID}.globalPreset\`, id)` → `useSetConfig(themeEngineConfig)("globalPreset", id)`

### 3.2 `plugins/ui/plugins/segmented-progress-bar` — `variant`

| Field | New |
|---|---|
| `variant` | `textField({ default: "segmented", label: "Progress bar variant" })` |

Files:
- `plugins/ui/plugins/segmented-progress-bar/core/config.ts`
- `.../server/index.ts`
- `.../web/index.ts`
- `.../web/components/variant-picker.tsx` — `useConfigValues` → `useConfig`; `setConfigValue` → `useSetConfig`
- `.../web/components/segmented-progress-bar.tsx` — `useConfigValues` → `useConfig`

### 3.3 `plugins/ui/plugins/tokens/plugins/color-adjust`

| Field | New |
|---|---|
| `preset` | `textField({ default: "default" })` |
| `hueShift` | `intField({ default: 0, label: "Hue shift" })` |
| `saturationScale` | `floatField({ default: 1, label: "Saturation" })` |
| `lightnessScale` | `floatField({ default: 1, label: "Lightness" })` |

Files:
- `plugins/ui/plugins/tokens/plugins/color-adjust/shared/config.ts`
- `.../server/index.ts`
- `.../web/index.ts` — update `ThemeEngine.ColorTransform` contribution (currently uses `useConfigValues` inline)
- `.../web/components/color-adjust-picker.tsx` — `useConfigValues` → `useConfig`; `setConfigValue` → `useSetConfig`

## Phase 4: Data migration (DB → JSONC)

### When it runs

At server startup, in `config_v2/server/index.ts` `onReady()`, **after** `initRegistry()` (needs the registry to resolve storePaths). One-time, idempotent.

### Implementation

New file: `plugins/config_v2/server/internal/migrate-from-db.ts`

```ts
export async function migrateConfigFromDb(db: DrizzleDb): Promise<void> {
  // 1. Check if old config table exists
  const exists = await tableExists(db, "config");
  if (!exists) return;

  // 2. Read all rows from old config table
  const rows = await db.execute(sql`SELECT key, value FROM config`);
  if (rows.length === 0) return;

  // 3. Group by pluginId: "ui-tokens-color-palette.preset" → pluginId="ui-tokens-color-palette", field="preset"
  const byPlugin = new Map<string, Map<string, unknown>>();
  for (const row of rows) {
    const fullKey = row.key as string;
    const dotIdx = fullKey.indexOf(".");
    if (dotIdx === -1) continue;
    const pluginId = fullKey.slice(0, dotIdx);
    const fieldKey = fullKey.slice(dotIdx + 1);
    let fields = byPlugin.get(pluginId);
    if (!fields) { fields = new Map(); byPlugin.set(pluginId, fields); }
    fields.set(fieldKey, row.value);
  }

  // 4. For each registered config_v2 descriptor, write user override if DB has values
  for (const entry of registryEntries()) {
    const { descriptor, pluginId, storePath } = entry;
    const dbFields = byPlugin.get(pluginId);
    if (!dbFields) continue;

    const overridePath = userOverridePath(storePath);
    if (existsSync(overridePath)) continue; // don't overwrite existing override

    const values: Record<string, unknown> = {};
    let hasNonDefault = false;
    for (const [key, field] of Object.entries(descriptor.fields)) {
      const dbVal = dbFields.get(key);
      if (dbVal !== undefined) {
        values[key] = dbVal;
        if (JSON.stringify(dbVal) !== JSON.stringify(field.defaultValue)) {
          hasNonDefault = true;
        }
      } else {
        values[key] = field.defaultValue;
      }
    }

    if (!hasNonDefault) continue; // all defaults, no override needed

    // Write override JSONC with hash of current origin
    writeOverrideFile(overridePath, values, originHash(storePath));
    console.log(`[config-v2] migrated ${pluginId} from DB → ${overridePath}`);
  }

  // 5. Delete migrated rows (only for plugins that have config_v2 registrations)
  // Secret fields are untouched — they live in the secrets store, not this table
}
```

### Key details

- **Idempotent**: Checks `existsSync(overridePath)` before writing. Safe to run on every startup.
- **Only deletes migrated rows**: Rows for plugins still on old config (auth, Config.Section consumers, token group plugins) are left in the table.
- **Error handling**: Per-plugin try/catch. One failure doesn't block others. Log errors prominently.
- **All in-scope values are primitive** (bool, string, number) — no JSON parse/stringify conversion needed. DB jsonb values map directly to JSONC.

### Wiring

```ts
// plugins/config_v2/server/index.ts
async onReady() {
  await initConfigWatcher();
  initRegistry();
  await migrateConfigFromDb(db); // after registry so storePaths are resolved
},
```

## Verification

After each consumer migration:

1. Run `./equin build` — generates `config/<hierarchy>/<name>.origin.jsonc` from the new `defineConfig` defaults
2. Verify the `.origin.jsonc` file exists with correct defaults
3. Verify `./equin check --config-origins-in-sync` passes
4. Open the config_v2 Settings UI and verify the plugin's fields appear
5. Change a value in Settings, verify it writes to `~/.singularity/config/<worktree>/<hierarchy>/<name>.jsonc`
6. Verify server-side `getConfig(descriptor)` returns the changed value (use `query_db` MCP or add a debug log)
7. For UI plugins: verify theme preset picker, variant picker, and color-adjust sliders still work

For the data migration:

1. Before migrating, note current DB values: `SELECT * FROM config`
2. Run `./equin build` (triggers server restart → migration)
3. Verify JSONC override files were created at `~/.singularity/config/<worktree>/...`
4. Verify DB rows for migrated plugins were deleted
5. Verify DB rows for non-migrated plugins (auth, Section consumers) are untouched
6. Verify the UI shows the same values as before migration
