# Model family choice: "Opus" means the current Opus

## Context

Every model picker saves a specific version (`opus-5`). When a new model ships
(Opus 5.5, commit 30232c376), every saved choice stays on the old version:
- 61 armed auto-start tasks on main (42 on `opus-4-8`, 18 on `opus-5`) still launch
  old models.
- Agents saved as `sonnet` launch Sonnet 4.6, because the old-alias table maps a bare
  `sonnet` to 4.6.

Nothing lets a user say "whatever Opus is newest".

Goal: a saved choice can be a **family**: `opus`, `sonnet` or `fable`. It shows as
**"Opus"**, with a grey hint of the version it runs today ("Opus · 5.5"). It is
resolved to a concrete version only when an agent is spawned. Pinned versions remain
possible, but each one is hidden from the pickers until the user turns it on in
Settings. Releasing a new model then needs no data changes: every family choice
follows it.

## Design

### Two types, two meanings

- `ConversationModel`: a concrete version id. It means **what ran** (or runs). It is
  unchanged and still used by `conversations.model`, `claude_cli_calls.model`, the
  spawn job, the runtime and `resolveCliFlag`.
- New `ModelChoice = ModelFamily | ConversationModel`: **what the user asked for**.
  Every saved preference uses it: auto-start marker, agent, launch prompt, default
  model config and launch endpoint inputs.

`resolveModel(choice): ConversationModel` is the only way from one to the other. The
spawn path's types only accept a concrete id, so tsc forces every launch through
`resolveModel`.

### Registry (`plugins/conversations/plugins/model-provider/core/registry.ts`)

- **"Current" is derived, not declared.** `MODEL_REGISTRY` is already listed newest
  first within each family. The current version of a family is its **first entry**.
  - Delete the hand-written `currentModelForTier` switch.
  - Delete the `defaultHidden` flag. Every concrete version is now hidden by default,
    so the flag no longer means anything.
  - Releasing a model becomes: add one entry above the old one. Nothing to flip.
- Add `version: "5.5"` to `ModelMeta` and derive `label` as `` `${Family} ${version}` ``.
  The grey hint (`5.5`) and the label then cannot disagree.
- Add:
  - `ModelFamily`: the tiers that have a selectable model (`opus`, `sonnet`,
    `fable`). Haiku is print-only, so it is not a session choice.
  - `ModelChoiceSchema`: strict, for inputs.
  - `StoredModelChoiceSchema`: tolerant through `tolerantEnum`, for saved values.
  - `DEFAULT_MODEL_CHOICE = "opus"`.
  - `SELECTABLE_CHOICES`: families first, then concrete versions.
  - `resolveModel(choice)`.
  - `choiceLabel(choice)`: "Opus" or "Opus 5".
  - `choiceHint(choice)`: "5.5" for a family, none for a pinned version.
- **Delete `LEGACY_ALIASES`.** A bare `opus` or `sonnet` is now a real family choice
  that means "current". A data migration fixes the one conversation row that is left
  over (see Migration).
- `normalizeModel` (the "what ran" reader) keeps reporting unknown values as
  corruption.
- `DEFAULT_MODEL` (concrete) goes away. The places that used it now use either
  `DEFAULT_MODEL_CHOICE` or `resolveModel(DEFAULT_MODEL_CHOICE)`.

### Resolution point (server)

- `prepareConversation` at `plugins/conversations/server/internal/lifecycle.ts:216`:
  `model = resolveModel(opts.model ?? inheritedModel ?? DEFAULT_MODEL_CHOICE)`.
  - `opts.model` becomes `ModelChoice`.
  - `inheritedModel` stays concrete: a resumed conversation keeps what it ran.
  - Everything downstream already reads this one value: the `conversations` insert,
    `SpawnCreate`, `spawn-job.ts`, `tmux-runtime.ts` → `--model`.
- `launchTaskNow` (`auto-start-jobs.ts:127`) passes the stored choice through
  unchanged, so it resolves at launch, not at arming.
- `run-claude-print.ts:61` calls `resolveModel(tier)` in place of `currentModelForTier`.
- **Drop the DB default on `conversations.model`.** Every insert already passes a
  resolved model. Today each model release regenerates a migration just to bump that
  default (as `20260922_221800` did). Dropping it removes that churn for good.

### Stored choices move to `ModelChoice`

The pattern is the same everywhere:
- A column read through a tolerant schema switches to `StoredModelChoiceSchema`.
- An input schema switches to `ModelChoiceSchema`.

Places:
- `plugins/tasks/plugins/auto-start/shared/resources.ts` (`autoStartModel`), its
  mutations, and the launch-option schema
  (`auto-start/plugins/launch-option/core/internal/option.ts`).
- `plugins/conversations/plugins/agents/core/endpoints.ts` and `schemas.ts`, plus
  `handle-launch.ts` (`body.model ?? agent.model ?? DEFAULT_MODEL_CHOICE`, with no
  normalizing before the spawn resolves it).
- `plugins/conversations/core/endpoints.ts` (`CreateConversationBodySchema.model`) and
  `plugins/tasks/core/endpoints.ts` (`LaunchTaskBodySchema.model`).
- MCP `add_task` (`plugins/tasks/server/internal/mcp-tools.ts`):
  - `autostart` defaults to `"opus"`.
  - It is parsed with `ModelChoiceSchema` in place of free text plus
    `normalizeModel`, so a typo is rejected instead of silently becoming the default.
  - The description tells agents to pass a family unless they need a specific version.
  - Same treatment for any other MCP tool that takes a model.
- Config:
  - `model-provider/shared/config.ts`: `defaultModel` becomes an enum over
    `SELECTABLE_CHOICES`, default `"opus"`. Each option carries `hint`, which the
    generic `ChoiceOption` already supports.
  - `visibleModels` gets one toggle per choice: families default **on**, concrete
    versions default **off**.
  - `launch-prompts/shared/config.ts` item `model`: same options, default `"opus"`.
  - `config.origin.jsonc` regenerates on build. No user overrides of these configs
    exist on main.

### Pickers (web)

- `model-provider/web`:
  - `useVisibleModels()` returns `ModelChoice[]`: families first, then versions the
    user turned on.
  - `useModelItems()` returns `{ value, label, hint? }`.
  - `useDefaultModel()` returns a `ModelChoice`.
- Render the hint once, in muted text, in each shared renderer:
  - `LaunchModelMenuContent` (`primitives/launch/web/components/launch-control.tsx`).
    This also covers the sidebar new-conversation button and the rewind and fork
    buttons.
  - `<ModelSelect>`, which the auto-start control on the task detail uses.
  - `AutoStartPillMenu`, which the task-draft popover uses.
- `agent-detail.tsx`: replace the raw `<select>` with `<ModelSelect>`, so it gets the
  families and hints like every other picker.
- Trigger and value displays (launch pill, sidebar button, auto-start pill, queued
  chip "Queued · Opus") use `choiceLabel`.
- `ModelBadge` on a conversation keeps showing the concrete version that ran
  ("Opus 5.5").

### Migration

One DML-only data migration, created with `./equin build --custom-migration`
(precedent: `20260601_130000_b4c0f111__backfill_conversation_model_aliases.sql`):

```sql
UPDATE tasks_ext_auto_start SET auto_start_model = split_part(auto_start_model, '-', 1)
  WHERE auto_start_model LIKE 'opus-%' OR auto_start_model LIKE 'sonnet-%' OR auto_start_model LIKE 'fable-%';
UPDATE conversations SET model = 'opus-4-6' WHERE model = 'opus';   -- a history row the 2026-06-01 backfill missed
```

- **Every** armed task becomes a family choice, including `opus-4-8`. Until now the
  pickers never offered a family, so none of those rows is a deliberate pin, and the
  goal is "no manual re-arming".
- Agents stored as `sonnet` (15) need no rewrite. Their meaning changes from Sonnet
  4.6 to current Sonnet (Sonnet 5), which is the intended behavior change.
- Then a schema migration drops the `conversations.model` default. Per the
  migrations CLAUDE.md "Case 1", create the data migration first and then run
  `--reset-migration` for the schema one.

### Docs

Update `model-provider/CLAUDE.md`:
- Family versus pinned choices.
- `resolveModel` is the only resolution point.
- "Releasing a model = add one entry at the top of its family."

## Verification

- `./equin test plugins/conversations/plugins/model-provider` with new registry
  tests:
  - every `ModelFamily` resolves to its first entry;
  - `choiceLabel` and `choiceHint`;
  - the tolerant schemas report unknown values.
- Also run the existing auto-start and price-table suites.
- `./equin build` (background). Then use `query_db` on the worktree DB:
  - `tasks_ext_auto_start` holds only `opus` / `sonnet` / `fable`;
  - no `conversations.model = 'opus'` row remains.
- Screenshots (`screenshot.ts --click`):
  - the launch dropdown lists Opus · 5.5 / Sonnet · 5 / Fable · 5.1 and no versions;
  - after turning Opus 5 on in Settings, it appears below the families;
  - the task-draft pill and the agent detail picker match.
- End to end in the worktree:
  - arm a test task with "Opus" and launch it: the new `conversations.model` is
    `opus-5-5`, and the tmux command line has `--model claude-opus-5-5`;
  - call `add_task` with `autostart: "opus"`, then with `"opus-5"` (pinned, stays
    `opus-5`), then with `"opsu"` (rejected).
