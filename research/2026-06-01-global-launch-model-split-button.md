# Redesign +Sonnet/+Opus into a split [dropdown | launch] model control

## Context

Today every "launch a conversation" surface renders a row of per-model buttons
(`+Opus`, `+Sonnet`) via the shared `LaunchButtons` primitive. The model identity
is only **logical** (`"opus" | "sonnet"`); which *version* of Opus runs is pinned by
a separate global config field (`opusVersion`: `4-6 | 4-7 | 4-8`) applied at launch
time by the server (`resolveCliFlag`). This has three problems:

1. **No per-conversation pinning** — an old Opus conversation re-resolves to whatever
   the global `opusVersion` currently is. Resuming history can silently change the model.
2. **Adding a model = two-button-per-model UI churn.** The button row doesn't scale
   past 2–3 models; it can't express "Opus 4.6 / Opus 4.8 / Sonnet" cleanly.
3. **Appearance and launch logic are fused** in one component, and there's no notion
   of a user-chosen *default* model.

**Goal:** replace the per-model button row with a single split control —
`[ <model dropdown> | <launch icon button> ]` — where the dropdown lists concrete
versioned models, selecting one persists it as the default, and each row offers a
one-time launch on hover. The model registry becomes the single source of truth that
drives **every** model picker in the app (launch, auto-start, task-draft, launch-prompts).

## Decisions (confirmed with user)

- **Flatten to concrete models.** `ConversationModel` becomes concrete ids
  (`opus-4-8`, `opus-4-6`, `sonnet-4-6`, …). The exact model is pinned in the DB per
  conversation. Legacy `"opus"/"sonnet"` rows are handled by a `normalizeModel()` alias map.
- **Dropdown UX:** clicking a model **row** sets it as the persisted default (updates the
  main launch button); the hover **launch icon** on each row fires that model **one-time**
  without changing the default; the main launch button fires the current default.
- **Rollout: all sites.** Redesign the shared primitive so every `LaunchButtons` consumer
  gets the split control; migrate `fork-session` / `branch` onto the exposed actions.

---

## Part A — Flatten the model registry (`model-provider/core`)

`plugins/conversations/plugins/model-provider/core/registry.ts` — rewrite to a flat,
concrete registry (keep this file **zero-dep**; `tasks-core` imports it for the column type):

```ts
export const ConversationModelSchema = z.enum([
  "opus-4-8", "opus-4-7", "opus-4-6", "sonnet-4-6",
]);
export type ConversationModel = z.infer<typeof ConversationModelSchema>;
export const DEFAULT_MODEL: ConversationModel = "opus-4-8";

export type ModelMeta = {
  cliFlag: string;
  label: string;        // "Opus 4.8"
  family: "opus" | "sonnet";
  iconSize: string;
  defaultHidden?: boolean; // older versions hidden from the dropdown by default
};

export const MODEL_REGISTRY: Record<ConversationModel, ModelMeta> = {
  "opus-4-8":   { cliFlag: "claude-opus-4-8",   label: "Opus 4.8",   family: "opus",   iconSize: "size-4" },
  "opus-4-7":   { cliFlag: "claude-opus-4-7",   label: "Opus 4.7",   family: "opus",   iconSize: "size-4", defaultHidden: true },
  "opus-4-6":   { cliFlag: "claude-opus-4-6",   label: "Opus 4.6",   family: "opus",   iconSize: "size-4", defaultHidden: true },
  "sonnet-4-6": { cliFlag: "claude-sonnet-4-6", label: "Sonnet 4.6", family: "sonnet", iconSize: "size-3" },
};

// Back-compat: rows written before flattening stored "opus"/"sonnet".
const LEGACY_ALIASES: Record<string, ConversationModel> = {
  opus: "opus-4-6",     // 4-6 was the pre-versioning default
  sonnet: "sonnet-4-6",
};

export function normalizeModel(stored: string): ConversationModel {
  if (stored in MODEL_REGISTRY) return stored as ConversationModel;
  return LEGACY_ALIASES[stored] ?? DEFAULT_MODEL;
}
```

`core/index.ts` — additionally export `normalizeModel`.

**`normalizeModel` is the boundary guard.** Apply it wherever a *stored* model string is
read back (legacy rows would otherwise fail `z.enum` parse or registry lookups):

- `plugins/conversations/server/internal/lifecycle.ts:74` — `inheritedModel = normalizeModel(source.model)`.
- `plugins/conversations/plugins/conversation-view/plugins/model/web/components/model-badge.tsx` —
  normalize before `MODEL_CLASSES`/label lookup; show `MODEL_REGISTRY[m].label` and color by `family`.
- `plugins/tasks/plugins/auto-start/server/internal/resource.ts:16` — `autoStartModel: normalizeModel(r.autoStartModel)`.

**DB column:** `plugins/tasks-core/server/internal/tables.ts:120` — change
`.default("opus")` → `.default(DEFAULT_MODEL)`. (`$type<ConversationModel>` stays `text`;
only the default literal changes → one generated migration via `./equin build`.)

---

## Part B — Config redesign (`model-provider`)

Replace the `opusVersion` enum with two registry-derived fields in
`plugins/conversations/plugins/model-provider/shared/config.ts`:

```ts
const modelEntries = Object.entries(MODEL_REGISTRY);

export const modelProviderConfig = defineConfig({
  fields: {
    defaultModel: enumField({
      label: "Default model",
      description: "Model fired by the launch button and pre-selected in the dropdown.",
      options: modelEntries.map(([value, m]) => ({ value, label: m.label })),
      default: DEFAULT_MODEL,
    }),
    visibleModels: objectField({
      label: "Models shown in the launch dropdown",
      subFields: Object.fromEntries(
        modelEntries.map(([id, m]) => [id, boolField({ label: m.label, default: !m.defaultHidden })]),
      ),
    }),
  },
});
```

- `objectField` (`config_v2/plugins/fields/plugins/object`) has a web renderer already —
  this gives one show/hide toggle per model in Settings, auto-syncing when the registry grows.
- **`opusVersion` is removed** → satisfies "replace the current model selector config".

**Server** `server/internal/resolve-cli-flag.ts` — now trivial (the concrete model already
encodes the version; no config read):

```ts
export function resolveCliFlag(model: ConversationModel): string {
  return MODEL_REGISTRY[normalizeModel(model)].cliFlag;
}
```

**Expose config to other plugins via web hooks** (respect R10: `shared/` is plugin-private;
do **not** import the descriptor cross-plugin). Add
`plugins/conversations/plugins/model-provider/web/internal/hooks.ts` and export from
`model-provider/web/index.ts`:

- `useVisibleModels(): ConversationModel[]` — registry order, filtered by `visibleModels` config.
- `useDefaultModel(): ConversationModel` — `normalizeModel(config.defaultModel)`.
- `useSetDefaultModel(): (m: ConversationModel) => void` — wraps `useSetConfig(...)("defaultModel", m)`.

`web/index.ts` keeps `ConfigV2.WebRegister`; `server/index.ts` keeps `ConfigV2.Register`.

---

## Part C — Split appearance from logic (`primitives/launch`)

`plugins/primitives/plugins/launch/web`:

- **Keep** `useLaunchConversation` (the launch action hook). Generalize its `launch`
  signature to `launch(model, e?)` so callers fire any model. This is the "common action"
  the plugin exposes.
- **New** `components/launch-control.tsx` exporting `LaunchControl` — the split control.
  Same prop surface as today's `LaunchButtons` (`getRequest`, `openAfterLaunch`, `onLaunched`,
  `variant`, `size`, `disabled`, `className`) so consumers swap with a rename.

`LaunchControl` composition (reuse existing primitives — no new UI library):

- Wrap in `<div data-slot="button-group" className="flex items-center">` (Button CSS
  auto-flattens inner border-radii).
- **Dropdown:** `DropdownMenu` / `DropdownMenuTrigger` / `DropdownMenuContent` /
  `DropdownMenuItem` from `@/components/ui/dropdown-menu`. Trigger shows
  `MODEL_REGISTRY[defaultModel].label` + chevron. Rows come from `useVisibleModels()`.
- **Main launch button:** `IconButton` (`@plugins/primitives/plugins/icon-button/web`),
  `icon={MdPlayArrow}`, `label="Launch {defaultLabel}"`, `onClick → launch(defaultModel)`.
- **Each dropdown row** (`group/dropdown-menu-item` already present):
  - row body = model label; `onClick`/`onSelect → setDefaultModel(id)` (closes menu).
  - hover-revealed `IconButton` (`opacity-0 group-hover/dropdown-menu-item:opacity-100`),
    `onClick` → `e.stopPropagation(); launch(id)` (one-time; does **not** set default).
  - right-aligned shortcut hint via `<Kbd>` (`@plugins/primitives/plugins/tooltip/web`)
    showing `formatShortcutLabel("mod+"+n)`. While the menu is open, a keydown handler maps
    the digit to a one-time `launch` of that row's model. (Contained to the open menu; no
    global registration — avoids collisions across the many on-screen launch controls.)
- `size` variants: `default`/`sm` render the labeled trigger + launch `IconButton`;
  `icon` renders a compact launch `IconButton` + a small chevron trigger (keeps
  `openAfterLaunch={false}` behavior for inline task cards / task-list rows).

`web/index.ts` — export `LaunchControl` (+ keep `useLaunchConversation`, `LaunchRequest`,
`LaunchAgentPopover`). Remove `LaunchButtons` (all consumers migrate).

---

## Part D — Migrate consumers

**Straight rename `LaunchButtons` → `LaunchControl`** (identical props):

- `plugins/welcome/web/components/welcome-view.tsx`
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`
- `plugins/attempt-view/web/components/attempt-pane.tsx`
- `plugins/screenshot/web/components/prompt-form.tsx`
- `plugins/active-data/plugins/task/web/components/task-card.tsx`
- `plugins/tasks/plugins/task-list/web/components/launch-agent-action.tsx`
- `plugins/tasks/plugins/task-description/web/components/task-description.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/fork-conversation/web/components/fork-conversation-buttons.tsx`

**Migrate hook-based custom UIs** (they currently iterate `MODEL_REGISTRY` for a 2-button row):

- `fork-session/web/components/fork-session-action.tsx` — replace the per-model
  `RowActionButton` loop with a compact `LaunchControl size="icon"`
  (`getRequest: () => ({ forkFromConversationId: convId })`).
- `branch/web/components/branch-buttons.tsx` — keep the prompt popover, but launch the
  `useDefaultModel()` model on submit and offer model choice via the same dropdown
  (`useVisibleModels()`), instead of `MODELS[0]`.

**Other model pickers — unify on the registry** (required: `"opus"/"sonnet"` are no longer
valid concrete ids):

- **auto-start:** `task-header.tsx` Select options → `useVisibleModels()` + an "Off" entry;
  `auto-start/shared/resources.ts` schema `z.enum(["opus","sonnet"])` →
  `ConversationModelSchema` (reads are normalized in `resource.ts`, Part A);
  `auto-start/server/internal/{tables,mutations}.ts` `$type`/param → `ConversationModel`;
  `queued-chip-action.tsx` label → `MODEL_REGISTRY[normalizeModel(m)].label`.
- **task-draft:** `model-chip.tsx` `ChainModel = "queue" | ConversationModel`, options =
  `useVisibleModels()` + a "No" entry; `task-draft-{popover,form}.tsx` default constants →
  `useDefaultModel()` (fallback `DEFAULT_MODEL`).
- **launch-prompts:** `launch-prompts/shared/config.ts` `model` enum options →
  registry-derived concrete ids (`default: DEFAULT_MODEL`); `launch-prompts-button.tsx`
  `MODEL_LABEL`/`MODEL_CLASS` maps → `MODEL_REGISTRY[normalizeModel(item.model)]`
  (label + `family`-based color). Old stored `"opus"/"sonnet"` normalize on read.

---

## Critical files (summary)

| Area | File | Change |
|---|---|---|
| Registry | `model-provider/core/registry.ts` (+`index.ts`) | Flatten + `normalizeModel` |
| Config | `model-provider/shared/config.ts` | `defaultModel` + `visibleModels`, drop `opusVersion` |
| Resolve | `model-provider/server/internal/resolve-cli-flag.ts` | Trivial lookup, no config |
| Hooks | `model-provider/web/internal/hooks.ts` (new) + `web/index.ts` | `useVisibleModels`/`useDefaultModel`/`useSetDefaultModel` |
| Control | `primitives/launch/web/components/launch-control.tsx` (new) + `web/index.ts` | `LaunchControl`; generalize `useLaunchConversation` |
| DB | `tasks-core/server/internal/tables.ts` | column default → `DEFAULT_MODEL` |
| Boundaries | `lifecycle.ts`, `model-badge.tsx`, auto-start `resource.ts` | `normalizeModel` on read |
| Consumers | 8 rename + fork-session/branch/auto-start/task-draft/launch-prompts | see Part D |

## Open polish (non-blocking)

- Per-row digit shortcuts are scoped to the open menu only; if a global "launch default"
  shortcut is wanted later it can be added via `defineShortcut` separately.

## Verification

1. `./equin build` from this worktree (regenerates the column-default migration, builds
   web + server). Confirm it starts clean and `./equin check --migrations-in-sync` passes.
2. App at `http://att-1780296369-j8ms.localhost:9000` — scripted Playwright run
   (`bun e2e/screenshot.mjs`):
   - Welcome / sidebar: split control shows the default model; open dropdown → Opus 4.8 +
     Sonnet visible, Opus 4.6/4.7 hidden by default; hover a row → launch icon + shortcut appear.
   - Click a non-default row → main button label updates (default persisted); reload → persists.
   - Click a row's hover launch icon → new conversation created with **that** model
     (verify via `query_db`: `select model from _conversations order by created_at desc limit 1`);
     default unchanged.
   - Click main launch button → fires the current default model.
3. Settings → Model Provider: `Default model` selector + per-model show/hide toggles render;
   toggling a model off removes it from the dropdown.
4. Back-compat: an existing pre-flatten conversation still renders a model badge (legacy
   `"opus"` → "Opus 4.6") and resumes without error.
5. Regression sweep of the other pickers: auto-start Select, task-draft model chip, and
   launch-prompts all list the concrete models and launch with the chosen concrete id.
