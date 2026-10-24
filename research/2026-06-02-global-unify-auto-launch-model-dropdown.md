# Unify the auto-start / auto-launch model dropdown

## Context

Picking "which model should auto-launch this" exists in **three** places, each with a
different UI:

| Surface | File | Current UI | Off sentinel |
|---|---|---|---|
| Prompt form | `plugins/tasks/plugins/task-draft-form/web/components/model-chip.tsx` | inline radio pills `No / Opus / Sonnet…` | `"queue"` |
| Task detail | `plugins/tasks/plugins/task-header/web/components/task-header.tsx` | shadcn `<Select>` `Off / Opus / Sonnet…` | `"none"` |
| Agent list row | `plugins/agents/plugins/auto-launch/plugins/toggle/web/components/auto-launch-toggle.tsx` | boolean rocket icon (on/off, **no model**) | — |

Three controls, three code paths, and the agent one can't even pick a model. We want **one
reusable controlled dropdown** — listing exactly the models the launch dropdown shows
(`useVisibleModels`) plus an "Off" option — used by all three. The agent toggle becomes a
real model picker, which requires migrating its side-table from a boolean to a stored
`ConversationModel`.

Outcome: a single `ModelSelect` primitive in `model-provider/web`; identical model list and
behavior everywhere; adding/hiding a model in the registry updates all four pickers (launch +
the three setters) with zero further changes.

## Design

### 1. New primitive: `ModelSelect` (model-provider/web)

`model-provider` already owns the registry, `useVisibleModels`, and `familyClass`, and already
has a `web/components/` dir. It's the correct home — lower-level plugins (tasks, agents) all
already depend on it; no new cross-plugin edges or cycles.

New file `plugins/conversations/plugins/model-provider/web/components/model-select.tsx`:

```ts
export interface ModelSelectProps {
  value: ConversationModel | null;            // null = Off
  onChange: (m: ConversationModel | null) => void;
  offLabel?: string;                          // default "Off"
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}
```

- Renders a shadcn `<Select>` (`@/components/ui/select`), sentinel `"none"` ⇄ `null`.
- Options: `useVisibleModels()` → `MODEL_REGISTRY[m].label`, with an "Off" item first.
- Normalizes the incoming `value` via `normalizeModel` before comparing.
- Trigger styled `h-7 text-xs` (matches the current task-header Select); width via `className`
  so each call site sizes it.

Export from `plugins/conversations/plugins/model-provider/web/index.ts`:
```ts
export { ModelSelect } from "./components/model-select";
export type { ModelSelectProps } from "./components/model-select";
```

### 2. Fix the `printOnly` leak in `useVisibleModels` (parity, structural)

`plugins/conversations/plugins/model-provider/web/internal/hooks.ts` currently returns
`ALL_MODELS.filter((id) => visibleModels[id] !== false)`. Because the `visibleModels` config
object has **no key** for `printOnly` models (Haiku), `undefined !== false` is `true`, so Haiku
**leaks into the launch dropdown today** — contradicting the explicit invariant in
`shared/config.ts` ("printOnly … must never appear in the launch dropdown"). Fix it at the
source so the launch dropdown and `ModelSelect` stay in lockstep:

```ts
const ALL_MODELS = (Object.keys(MODEL_REGISTRY) as ConversationModel[])
  .filter((id) => !MODEL_REGISTRY[id].printOnly);
```

This is the clean structural fix (one place), not a per-component filter. It also corrects the
`mod+N` launch shortcuts in `LaunchControl`.

### 3. Wire the three surfaces

**task-header** (`task-header.tsx`): delete the inline `<Select>` block (and now-unused
`Select*`, `MODEL_REGISTRY`, `useVisibleModels` imports) →
```tsx
<ModelSelect
  value={autoStart?.autoStartModel != null ? normalizeModel(autoStart.autoStartModel) : null}
  onChange={(m) => void setAutoStart(taskId, m ?? "none")}
  ariaLabel="Auto-start model" className="w-32"
/>
```
`AutoStartModel`/`setAutoStart` in `plugins/tasks/web/client.ts` are unchanged.

**ModelChip** (`model-chip.tsx`): keep the `ChainModel` type, `ModelChipProps`, and the
"Auto-launch with" label so every caller (`task-draft-card`, `task-draft-form`,
`task-draft-popover`, `submit.ts`, barrel) is untouched. Swap the radio group for:
```tsx
<ModelSelect
  value={value === "queue" ? null : value}
  onChange={(m) => onChange(m ?? "queue")}
  offLabel="No" ariaLabel="Launch model" disabled={disabled}
/>
```

**Agent auto-launch** (`auto-launch-toggle.tsx`): keep the exported name `AutoLaunchToggle`
(so `web/index.ts`'s slot contribution is untouched); replace the rocket button with
`ModelSelect` reading `row?.model ?? null` and calling POST/DELETE (see §4).

### 4. Agent side-table migration: boolean → model

Mirror the tasks auto-start convention (POST sets model, DELETE clears). All files under
`plugins/agents/plugins/auto-launch/plugins/toggle/`:

- **`server/internal/tables.ts`** — replace `enabled: boolean().notNull().default(false)` with
  a nullable `autoLaunchModel: text("auto_launch_model").$type<ConversationModel>()`.
- **`shared/resources.ts`** — row schema `{ parentId, model: ConversationModelSchema.nullable() }`;
  update `AgentAutoLaunchRow`.
- **`shared/endpoints.ts`** — `SetAgentAutoLaunchBodySchema` → `{ model: ConversationModelSchema }`;
  add `clearAgentAutoLaunch = defineEndpoint({ route: "DELETE /api/agent-auto-launch/:agentId" })`.
- **`shared/index.ts`** — export updated types + both endpoints.
- **`server/internal/handle-set.ts`** — `handleSet`: `agentAutoLaunch.upsert(id, { autoLaunchModel: body.model })`;
  add `handleClear`: `agentAutoLaunch.delete(id)`. Both `notify()`.
- **`server/internal/resource.ts`** — loader maps `r.autoLaunchModel` → `model`.
- **`server/index.ts`** — register the DELETE route alongside POST.
- **`web/components/auto-launch-toggle.tsx`** — `ModelSelect` + a `setAutoLaunchModel(agentId, m)`
  helper that `fetch`es POST `{model}` when set / DELETE when `null`.

The migration is auto-generated by `./equin build` (never hand-write it). The old
`enabled` data is dropped — acceptable: there is **no server consumer** of this flag today
(it's scaffolding; confirmed by repo-wide search — nothing reads `enabled === true` to launch),
so nothing depends on preserving it.

### Decisions taken (not blocking)

- **Endpoint shape**: POST `{model}` + DELETE, mirroring `tasks setAutoStart`. Cleaner than
  `POST {model: null}`.
- **Folder/id name**: keep the folder `toggle/` and plugin id `agents-auto-launch-toggle`
  (renaming churns the registry + generated files for no functional gain); only update the
  human description strings to say "model picker" instead of "toggle".
- **`QueuedChipAction`** (task list read-only "Queued · {model}" badge): unaffected — it reads
  the tasks side-table, not the agent one.

## Files

New:
- `plugins/conversations/plugins/model-provider/web/components/model-select.tsx`

Modified:
- `plugins/conversations/plugins/model-provider/web/index.ts` (export)
- `plugins/conversations/plugins/model-provider/web/internal/hooks.ts` (printOnly fix)
- `plugins/tasks/plugins/task-header/web/components/task-header.tsx`
- `plugins/tasks/plugins/task-draft-form/web/components/model-chip.tsx`
- `plugins/agents/plugins/auto-launch/plugins/toggle/server/internal/tables.ts`
- `plugins/agents/plugins/auto-launch/plugins/toggle/server/internal/resource.ts`
- `plugins/agents/plugins/auto-launch/plugins/toggle/server/internal/handle-set.ts`
- `plugins/agents/plugins/auto-launch/plugins/toggle/server/index.ts`
- `plugins/agents/plugins/auto-launch/plugins/toggle/shared/resources.ts`
- `plugins/agents/plugins/auto-launch/plugins/toggle/shared/endpoints.ts`
- `plugins/agents/plugins/auto-launch/plugins/toggle/shared/index.ts`
- `plugins/agents/plugins/auto-launch/plugins/toggle/web/components/auto-launch-toggle.tsx`

## Verification

1. `./equin build` from the worktree — must complete clean (TS enforces the
   `ConversationModel | null` contract end-to-end) and auto-generate the
   `agents_ext_auto_launch` migration.
2. `query_db`: `SELECT * FROM agents_ext_auto_launch LIMIT 5;` → has `auto_launch_model`
   (nullable text), no `enabled` column.
3. Playwright via `e2e/screenshot.mjs` on each surface (use real ids):
   - Task detail: Auto-start row shows the `<Select>` with Off + models, **no Haiku**.
   - Improve / task-draft popover: "Auto-launch with" row is now a Select (no radio pills).
   - Agent list row: rocket gone, model Select present.
   - Launch dropdown: confirm Haiku no longer listed (printOnly fix).
4. Agent round-trip: POST `/api/agent-auto-launch/<id>` `{ "model":"opus-4-8" }` then `query_db`
   shows `opus-4-8`; DELETE then row is gone — both reflected live in the UI dropdown.
