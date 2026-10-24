# Config v2 Migration: 4 List-Based Plugins

## Context

Several plugins still use config v1 (`defineConfig` from `@plugins/config/core`, `Config.Spec`, `Config.Field`, `Config.Section`) and plugin-owned DB tables for list data. Config v2 provides `listField` with auto-rendered settings UI (drag-and-drop, add/remove), eliminating the need for custom CRUD endpoints, DB tables, push resources, and settings components.

**Plugins to migrate (in order):**
1. `stats/commits` — simplest, scalar + list, server reads config
2. `review/code-review` — two lists + nested list, web-only config reads
3. `launch-prompts` — one list, no existing config
4. `prompt-templates` — one list + one scalar, drop useCount

## Reference Pattern

The `conversation-category` plugin is the canonical v2 list migration reference. Key files:
- Config: `plugins/conversations/plugins/conversation-category/shared/config.ts`
- Server: `ConfigV2.Register({ descriptor })` from `@plugins/config_v2/server`
- Web: `ConfigV2.WebRegister({ descriptor })` from `@plugins/config_v2/web`
- Read: `useConfig(descriptor)` / `getConfig(descriptor)` — synchronous on server
- Write: `useSetConfig(descriptor)` → `setConfig("key", newValue)` — full-array replacement for lists

---

## 1. stats/commits

**Location:** `plugins/stats/plugins/commits/`

**What changes:** `excludedPaths: string[]` + separate `excludedPathState` DB table (per-path enabled toggle) → single `listField({ path, enabled })`. `filterRebases: boolean` → `boolField`.

### Config (`shared/config.ts`)

```ts
import { defineConfig } from "@plugins/config_v2/core";
import { boolField, textField } from "@plugins/config_v2/plugins/fields/plugins/primitives/core";
import { listField } from "@plugins/config_v2/plugins/fields/plugins/list/core";

export const commitsConfig = defineConfig({
  fields: {
    excludedPaths: listField({
      label: "Excluded paths (line stats)",
      description: "File path prefixes excluded from line-change stats.",
      itemFields: {
        path: textField({ label: "Path" }),
        enabled: boolField({ label: "Enabled", default: true }),
      },
      default: [
        { path: "research/", enabled: true },
        { path: "server/src/db/migrations/meta/", enabled: true },
      ],
    }),
    filterRebases: boolField({
      default: false,
      label: "Filter rebases (deduplicate by push)",
    }),
  },
});
```

### Server changes

- `server/index.ts`: Replace `Config.Field(commitsConfig)` + `Resource.Declare(excludedPathStateResource)` + 3 excluded-path-state routes → `ConfigV2.Register({ descriptor: commitsConfig })`. Keep 4 data routes.
- `server/internal/handle-cumulative.ts` + `handle-rate.ts`: Replace `readConfig(commitsConfig)` (async) + `activeExcludedPaths()` (DB query) with `getConfig(commitsConfig)` (synchronous) + inline filter:
  ```ts
  const { excludedPaths } = getConfig(commitsConfig);
  const active = excludedPaths.filter(p => p.enabled).map(p => p.path);
  ```

### Web changes

- `web/index.ts`: Replace `Config.Spec` + `Config.Section` → `ConfigV2.WebRegister({ descriptor: commitsConfig })`
- `web/components/excluded-path-toggles.tsx`: Replace `useConfigValues` + `useResource(excludedPathStateResource)` with `useConfig(commitsConfig)` + `useSetConfig(commitsConfig)`. Toggle = mutate full array with one item's `enabled` flipped.
- `web/components/commits-section.tsx`: Replace `useConfigValues` + `setConfigValue` with `useConfig` + `useSetConfig`
- `web/components/lines-charts.tsx`: Replace `useResource(excludedPathStateResource)` filterKey with `JSON.stringify(useConfig(commitsConfig).excludedPaths)`

### Delete

- `server/internal/tables.ts` — `stats_commits_excluded_path_state` pgTable
- `server/internal/excluded-paths.ts` — resource + handlers + activeExcludedPaths
- `shared/endpoints.ts` — excluded-path-state endpoint definitions (keep data endpoints if separate)

---

## 2. review/code-review

**Location:** `plugins/review/plugins/code-review/`

**What changes:** `safePaths`/`carefulPaths` string-lists → `listField({ path })` each. `review_sections` DB table → nested `listField({ name, patterns: listField({ pattern }) })`.

### Config (`shared/config.ts`)

```ts
import { defineConfig } from "@plugins/config_v2/core";
import { textField } from "@plugins/config_v2/plugins/fields/plugins/primitives/core";
import { listField } from "@plugins/config_v2/plugins/fields/plugins/list/core";

export const reviewConfig = defineConfig({
  fields: {
    safePaths: listField({
      label: "Safe paths",
      description: "Path prefixes that require no special attention during review.",
      itemFields: { path: textField({ label: "Path" }) },
      default: [
        { path: "plugins/" }, { path: "docs/" }, { path: "e2e/" },
        { path: "research/" }, { path: "sidequests/" }, { path: "bun.lock" },
      ],
    }),
    carefulPaths: listField({
      label: "Careful paths",
      description: "Path prefixes that deserve extra care.",
      itemFields: { path: textField({ label: "Path" }) },
      default: [
        { path: "web/src/plugins.ts" },
        { path: "server/src/db/migrations/meta/" },
      ],
    }),
    sections: listField({
      label: "Review Sections",
      description: "Named groups of file patterns for organizing code review.",
      itemFields: {
        name: textField({ label: "Section name" }),
        patterns: listField({
          label: "Patterns",
          itemFields: { pattern: textField({ label: "Pattern" }) },
          default: [],
        }),
      },
      default: [{
        name: "Auto-generated",
        patterns: [
          { pattern: "**/CLAUDE.md" },
          { pattern: "docs/plugins-compact.md" },
          { pattern: "docs/plugins-details.md" },
          { pattern: "server/src/db/migrations/" },
        ],
      }],
    }),
  },
});
```

### Server changes

- `server/index.ts`: Remove `Config.Field` + `Resource.Declare` + 4 CRUD routes + `onReady(seedDefaults)` → `ConfigV2.Register({ descriptor: reviewConfig })`

### Web changes

- `web/index.ts`: Remove `Config.Spec` + `Config.Section` → `ConfigV2.WebRegister({ descriptor: reviewConfig })`
- `web/components/review-file-row.tsx` + `code-review-summary.tsx`: Replace `useConfigValues` with `useConfig`. Extract paths: `safePaths.map(p => p.path)`.
- `web/components/code-review-section.tsx`: Replace `useResource(reviewSectionsResource)` with `useConfig(reviewConfig).sections`. Map to `groupBySection` shape at call site: `sections.map(s => ({ id: s.id, name: s.name, patterns: s.patterns.map(p => p.pattern) }))`
- `web/core-files.ts`: Keep `groupBySection` signature unchanged. Define a local `ReviewSection` interface (the shared type is deleted).

### Delete

- `server/internal/tables.ts`, `resources.ts`, `seed.ts`, `handle-create/update/delete/list.ts`, `rank.ts`
- `web/components/review-sections-settings.tsx`
- `shared/resources.ts`, `shared/endpoints.ts`

---

## 3. launch-prompts

**Location:** `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/`

**What changes:** DB table `launch_prompts` + attachments + CRUD → single `listField({ title, prompt, model })`.

### Config (`shared/config.ts` — new file)

```ts
import { defineConfig } from "@plugins/config_v2/core";
import { textField } from "@plugins/config_v2/plugins/fields/plugins/primitives/core";
import { listField } from "@plugins/config_v2/plugins/fields/plugins/list/core";
import { multilineTextField } from "@plugins/config_v2/plugins/fields/plugins/multiline-text/core";
import { enumField } from "@plugins/config_v2/plugins/fields/plugins/enum/core";

export const launchPromptsConfig = defineConfig({
  fields: {
    prompts: listField({
      label: "Launch Prompts",
      description: "Pre-configured prompts that launch a background conversation.",
      itemFields: {
        title: textField({ label: "Title" }),
        prompt: multilineTextField({ label: "Prompt" }),
        model: enumField({
          label: "Model",
          options: [
            { value: "sonnet", label: "Sonnet" },
            { value: "opus", label: "Opus" },
          ],
          default: "sonnet",
        }),
      },
      default: [],
    }),
  },
});
```

### Server changes

- `server/index.ts`: Strip to `ConfigV2.Register({ descriptor: launchPromptsConfig })`. No routes.

### Web changes

- `web/index.ts`: Replace `Config.Section` → `ConfigV2.WebRegister({ descriptor: launchPromptsConfig })`. Keep `Conversation.PromptBar`.
- `web/components/launch-prompts-button.tsx`: Replace `useResource(launchPromptsResource)` with `useConfig(launchPromptsConfig).prompts`. Item shape unchanged (`.title`, `.prompt`, `.model`, `.id` all still present). Type `item.model` as `string` — use existing `MODEL_LABEL`/`MODEL_CLASS` maps with cast.

### Delete

- All `server/internal/` files (tables, tables-attachments, resources, handle-*.ts, rank.ts)
- `web/components/launch-prompts-settings.tsx`
- `shared/resources.ts`, `shared/endpoints.ts`
- Update `shared/index.ts` to export only config

---

## 4. prompt-templates

**Location:** `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/`

**What changes:** DB table `prompt_templates` + attachments + CRUD → `listField({ title, prompt })` + `pinnedCount: intField`. Drop `useCount` tracking.

### Config (`shared/config.ts` — rewrite)

```ts
import { defineConfig } from "@plugins/config_v2/core";
import { intField, textField } from "@plugins/config_v2/plugins/fields/plugins/primitives/core";
import { listField } from "@plugins/config_v2/plugins/fields/plugins/list/core";
import { multilineTextField } from "@plugins/config_v2/plugins/fields/plugins/multiline-text/core";

export const promptTemplatesConfig = defineConfig({
  fields: {
    pinnedCount: intField({
      default: 5,
      label: "Pinned templates",
      description: "Number of templates shown as persistent chips in the prompt editor toolbar.",
    }),
    templates: listField({
      label: "Prompt Templates",
      description: "Templates that prepend text to the prompt editor.",
      itemFields: {
        title: textField({ label: "Title" }),
        prompt: multilineTextField({ label: "Prompt" }),
      },
      default: [],
    }),
  },
});
```

### Server changes

- `server/index.ts`: Strip to `ConfigV2.Register({ descriptor: promptTemplatesConfig })`. No routes.

### Web changes

- `web/index.ts`: Replace `Config.Spec` + `Config.Section` → `ConfigV2.WebRegister({ descriptor: promptTemplatesConfig })`. Keep `PromptEditorSlots.FloatingAction`.
- `web/components/prompt-template-chips.tsx`:
  - Replace `useResource(promptTemplatesResource)` + `useConfigValues(promptTemplatesConfig, ...)` with `useConfig(promptTemplatesConfig)`
  - Access `templates` and `pinnedCount` directly: `const { templates, pinnedCount } = useConfig(promptTemplatesConfig)`
  - Drop `void fetch(\`/api/prompt-templates/${t.id}/use\`, ...)` call (useCount removed)
  - Drop `void fetchEndpoint(usePromptTemplate, { id: t.id })` call
  - Remove `pending` guard (config is always present, never pending)

### Delete

- All `server/internal/` files (tables, tables-attachments, resources, handle-*.ts, rank.ts)
- `web/components/prompt-templates-settings.tsx`
- `shared/resources.ts`, `shared/endpoints.ts`
- Update `shared/index.ts` to export only config

---

## Verification

After each plugin, run `./equin build` to generate DROP TABLE migrations, rebuild, and verify:
1. Settings UI auto-renders the new config fields with list CRUD (add/remove/reorder)
2. Consumer components work correctly with the new data shape
3. No TypeScript errors, no stale imports
