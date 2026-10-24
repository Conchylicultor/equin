# Runtime model discovery

## Context

The set of models an agent can run is compiled in
`plugins/conversations/plugins/model-provider/core/registry.ts`: `ConversationModelSchema` is a closed
`z.enum`, and `MODEL_DEFS` is a `Record<ConversationModel, …>` whose first entry in each family is that
family's current version. Every Anthropic release needs someone to edit that file, and to regenerate
`config/conversations/model-provider/config.origin.jsonc` (the options and `visibleModels` keys come
from the list), then build and push. Sonnet 5.5 (commit `4f7d468b63`) was the latest example. Until
that lands, "Sonnet" keeps running the old version.

Goal: a new version of a known family is discovered at runtime. It becomes that family's current
version (so "Sonnet" runs it) and shows in pickers and labels live, with no code change and no rebuild.

Decided with the user:

- **Families stay a compile-time set.** fable, opus, sonnet and haiku each carry a label, a colour,
  an icon size and a tier order; a family's name is also its CLI alias. Only versions are discovered.
- **A retired pinned version refuses loudly.** It is hidden from pickers, and a launch that still
  names it fails with "Opus 4.6 is retired — pick another". It never falls back silently to another
  model.
- **The installed CLI's model menu is the truth** for what each family runs, what is offered, and
  what is retired.

## Key findings

1. **The CLI answers "what does it offer" at no cost: the Agent SDK's control protocol.**
   One `initialize` control request, spoken directly to the CLI:
   ```
   printf '%s\n' '{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize"}}' \
     | claude -p --input-format stream-json --output-format stream-json --verbose --strict-mcp-config --no-session-persistence
   ```
   exits 0 in ~2 s with exactly one `control_response` line, answered locally: no assistant
   message, no model call, nothing billed (verified on Claude Code 2.1.286/2.1.287 with a
   subscription login, no API key). Its inner `response.models` is the CLI's model menu:
   - each family alias with what it resolves to (`{value:"sonnet", resolvedModel:"claude-sonnet-5-5"}`),
     i.e. that family's current version — haiku resolves to the dated `claude-haiku-4-5-20251001`;
   - every older version the CLI still offers (`{value:"claude-opus-4-8", resolvedModel:"claude-opus-4-8"}`, …);
   - `default` (the CLI's own pick, ignored), plus per-model `supportedEffortLevels` (not read yet).

   This is the installed CLI's own table, read with its own auth (and so any settings or env
   overrides of it). It is the thing that actually runs the agent, so it is the right authority.
   - `/v1/models` is rejected: it needs an API key, and the app deliberately has none (grep found
     no `ANTHROPIC_API_KEY`).
   - The LiteLLM table is rejected as a *source*: it lists Bedrock and Vertex ids and prices, not
     what the CLI can run. It stays the cost stats' concern, and a newly discovered model with no
     price already surfaces as an unpriced-model report.
   - History: a first version probed each alias with `claude -p --model <alias>` and read the
     `system/init` frame, with the network deliberately broken so no turn was billed; it was
     replaced by `initialize`, the supported interface.
2. **The id alone says almost everything.** Every id follows `<family>-<major>[-<minor>]`, and from
   it alone we get:
   - `cliFlag = claude-${id}`
   - `version` = the digits joined with "."
   - `label = ${FAMILY_META.label} ${version}`

   So `MODEL_DEFS` is redundant. Only three things need runtime data: which version is current, the
   set offered in pickers, and retirement.
3. **Consumers of the closed union** (the full map is in the exploration notes):
   - One `Record<ConversationModel,…>` (`MODEL_DEFS`) and the `MODEL_REGISTRY[id]` index reads:
     `call-row.tsx`, `model-badge.tsx`, `notify-created-job.ts`, `resolve-cli-flag.ts`,
     `cost/handlers.ts`, `calls-view.tsx`.
   - Strict `z.enum` inputs in the conversations, tasks and agents endpoints, the launch option, the
     `add_task` MCP `autostart`, `spawn-job.ts`, and `claude-cli/core/resources.ts:96`.
   - The config `enumField` / `objectField`, derived from `SELECTABLE_CHOICES` at module load.
   - One literal pin: `summary/server/internal/mcp-tools.ts` `SUMMARY_MODEL_ID = "sonnet-4-6"`.
   - There are no exhaustive `switch`es.

## Design

### 1. Types: a closed union becomes a checked id format

In `model-provider/core/registry.ts`:

- `MODEL_TIERS` and `FAMILY_META` stay closed. A family's name doubles as its CLI alias.
- `ConversationModelSchema` checks the format and brands the result:
  `z.string().regex(^(fable|opus|sonnet|haiku)-\d+(-\d+)?$)` built from `MODEL_TIERS`, then
  `.brand<"ConversationModel">()`.
  - `parseModelId(raw)` returns a result.
  - `modelIdFromCliName("claude-haiku-4-5-20251001")` strips `claude-` and the date suffix, which
    replaces `idForCliName`.
- `modelMeta(id): ModelMeta` is a pure function of the id (cliFlag, family, version, label,
  iconSize). It replaces `MODEL_REGISTRY` and `resolveCliFlag`, and needs no catalog. Every
  `MODEL_REGISTRY[x]` call site becomes `modelMeta(x)`.
- `ModelChoiceSchema` = a family name (`z.enum(MODEL_TIERS)`) or a `ConversationModelSchema`.
- **Stored schemas** (`StoredModelSchema`, `StoredModelChoiceSchema`, still `tolerantEnum`):
  - A well-formed id is valid *even if this backend's catalog has not seen it*. For example, a row
    written by a newer checkout gets its label from the id.
  - Only a malformed value is corruption, reported exactly as today.
  - This is the answer to "unknown stored values are reported as corruption": "unknown" and
    "corrupt" come apart.
- **The type no longer lists every model.** That is intentional. tsc still rejects a family string
  where a concrete version is needed (the brand), and it still forces every launch through
  `resolveModel`.
- The `SUMMARY_MODEL_ID` literal becomes a family choice (`"sonnet"`) resolved at call time. A pin
  inside the code would go stale in exactly the way this plan removes.

### 2. The catalog: data kept on disk at the machine level, discovered on a schedule

New sub-plugin `conversations/model-provider/plugins/catalog`:

- **core**:
  - The `ModelCatalog` shape:
    - `versions: { id, firstSeenAt, source: "baseline" | "cli", retiredAt?, retiredReason? }[]`
    - `current: Record<ModelTier, id>`
    - `probedAt`, and `cliVersion` (the Claude CLI version whose menu was read)
  - The pure readers, which take the catalog as an explicit argument:
    - `resolveModel(choice, catalog)` returns `{ok:true, model} | {ok:false, reason:"retired"|"unknown", …}`
    - `choiceHint(choice, catalog)`
    - `selectableChoices(catalog)`
    - `isRetired(id, catalog)`
  - The `modelCatalog` `liveValue` (declared `preload: "boot-and-keep"`, so pickers never render a
    stand-in).
  - `BASELINE_MODELS`: today's ids, as the floor for a machine that has never probed or has no CLI.
    It is the same idea as `litellm-fallback.json`. It is never edited again for a release.
- **data-dirs**:
  - `defineDataDir({kind:"state", name:"model-catalog", reclaim:{kind:"never"}})`.
  - The kind is state, not cache, because the retirement and first-seen history cannot be rebuilt.
  - One `catalog.json`, written atomically (tmp + rename). Its one writer is the discovery job (a
    host singleton), so no lock.
  - Precedent: `stats/cost` `costUsageDir` and `savePriceTable`.
- **server**:
  - `getModelCatalog()` is an in-memory copy, read at boot (falling back to the baseline) and
    reloaded by a file watcher (`infra/file-watcher`).
  - `serveValue(modelCatalog, {source:"external", whileSubscribed: watch → notify})`, following the
    `infra/deps/server/internal/live.ts` precedent. Every worktree backend sees main's writes live.
- **Discovery job** `models.discover`:
  - A `defineJob` with `schedule: { cron: "0 5 * * *" }`, `dedup: "singleton"`, main only, gated
    by `isHostSingleton()` so a compiled release also runs it (see the gap noted in
    `cost/refresh-job.ts`).
  - It sends one `initialize` request (`readCliModels`) with the same host env the agent panes
    use, and parses the `control_response` with a strict schema naming only `value`,
    `resolvedModel`, `displayName`: a changed protocol fails the run loudly.
  - `readMenu` places each entry, `applyMenu` folds it into the catalog:
    - `current[family]` = the family alias's `resolvedModel` (through `modelIdFromCliName`);
    - the offered set = every entry's resolved id; a new one is appended (`source: "cli"`);
    - a known version absent from the menu is retired ("no longer offered by Claude Code <ver>"),
      one that reappears is un-retired; a family's current version always counts as offered.
  - An entry it cannot place (an alias that is not a family, a name outside the id format, an alias
    resolving to another family) or a family missing from the menu files a `model-unrecognized`
    report and changes nothing for it (a missing family keeps its current). A menu naming no known
    family fails the run with the catalog untouched.
  - A CLI that is missing or signed out records a skipped run and leaves the catalog untouched.
    The CLI version comes from the availability probe (`checkClaudeCode()`).
  - The cron is **daily** (`0 5 * * *`). The CLI-version trigger is the real freshness signal.
- **Push-based triggers, with no polling:**
  - The cron above covers the case where nothing changes locally.
  - The availability probe (`claude-cli/availability`, which already runs `claude --version`)
    enqueues `models.discover` when the reported CLI version differs from `catalog.cliVersion`. A
    CLI auto-update is exactly when the menu moves, so a new model usually shows up within minutes of
    the CLI knowing about it.
  - Run now in Background activity comes free with `defineJob`.
- **When `current[family]` changes**, the job posts one bell notification (`shell/notifications`),
  e.g. "Sonnet now runs 5.5".

### 3. Retirement: a pinned version is refused loudly

- **Detection has one source: the CLI's menu.** Discovery retires a known version the installed
  CLI no longer offers, and un-retires it if it comes back. (An earlier draft also retired a version
  when a launch was refused as `model_not_found`; the menu makes that redundant.)
- **Effect**:
  - `selectableChoices` omits retired versions.
  - `resolveModel` returns `{ok:false, reason:"retired"}`. Both callers throw a typed
    `ModelUnavailableError` (an HttpError 409 with the label and the current alternatives):
    - `lifecycle.ts:228` (spawn)
    - `run-claude-print.ts`
  - A pending auto-start fails visibly on the task, the same way other launch refusals do.
  - A family's current version is never retired: it comes from the alias, and always counts as
    offered.

### 4. Input validation: the id format at parse time, the catalog at the endpoint

- Request schemas keep the strict `ModelChoiceSchema` (the id format).
- A new `assertChoiceLaunchable(choice, getModelCatalog())` rejects ids that are unknown or
  retired with a 400 that lists the current choices. It is called in:
  - the handlers that take a choice (conversations create, tasks create and auto-start, agents
    create and update)
  - the launch-option `apply`
- **`add_task` MCP `autostart`** becomes the id-format schema (`z.union([z.enum(MODEL_TIERS), <pattern>])`),
  so the MCP JSON schema gets an enum plus a pattern.
  - Its description names the families and the pinned format. It no longer hardcodes "opus-5".
  - The runtime check returns the live list on error.
  - The catalog is not baked into the JSON schema, because MCP schemas are fixed when the tool is
    registered.
- `spawn-job.ts` input and `claude-cli/core/resources.ts:96` switch to the branded id-format schema.

### 5. Config and pickers

- `defaultModel`:
  - Becomes `dynamicEnumField` (`fields/dynamic-enum/config`).
  - model-provider's web contributes `DynamicEnum.Options` from `useModelCatalog()` →
    `selectableChoices`, with labels like "Opus · 5.5".
  - Reads keep going through `normalizeModelChoice`.
- `visibleModels`:
  - Becomes a free-key `Record<string, boolean>` (the json field type) with the same meaning:
    - a key that is absent means the default (families on, versions off);
    - this means existing saved user files load unchanged.
  - The Settings control is a small custom renderer that lists `selectableChoices(catalog)` as
    toggles. It follows the dynamic-enum pattern: options come from a slot matched by the field
    descriptor, with the renderer in `fields/dynamic-enum/config` or a sibling `dynamic-flags`
    field if the existing renderer cannot express multiple choices.
  - Result: `config.origin.jsonc` stops listing models and no longer changes with each release.
- `launch-prompts/shared/config.ts` `model` gets the same `dynamicEnumField` treatment.
- Web hooks: `useVisibleModels` / `useModelItems` / `ModelSelect` read `useModelCatalog()` plus the
  config. When a new model is discovered, every picker, hint ("· 5.5") and filter re-renders through
  the live push:
  - `calls-view.tsx` tier chips
  - `all-conversations` model filter options: these are compiled `enum` options today, so they
    become data-view options derived from the catalog

## Critical files

- `plugins/conversations/plugins/model-provider/core/registry.ts`: the id format, `modelMeta`, and
  the schemas; `MODEL_DEFS` and `MODEL_REGISTRY` are deleted.
- `plugins/conversations/plugins/model-provider/{shared/config.ts, web/internal/hooks.ts, web/internal/items.ts, web/components/model-select.tsx, server/internal/resolve-cli-flag.ts (delete), CLAUDE.md}`.
- New `plugins/conversations/plugins/model-provider/plugins/catalog/{core,server,web,data-dirs}`.
- `plugins/conversations/server/internal/lifecycle.ts`, `spawn-job.ts`:
  `resolveModel(choice, getModelCatalog())`.
- `plugins/infra/plugins/claude-cli/server/internal/run-claude-print.ts` (`requireModel` against the
  live catalog) and `…/availability/server/internal/status.ts` (`onClaudeCodeProbed`: discovery on a
  CLI version change).
- `plugins/tasks/server/internal/mcp-tools.ts`, and the endpoint handlers in `conversations`,
  `tasks` and `agents`: `assertChoiceLaunchable`.
- The `MODEL_REGISTRY[...]` call sites become `modelMeta(...)`. Representative: `debug/claude-cli-calls/web/components/call-row.tsx`,
  `conversation-view/plugins/model/web/components/model-badge.tsx`,
  `stats/cost/server/internal/handlers.ts`.
- `stats/cost/server/internal/price-table.test.ts`: iterates `BASELINE_MODELS` instead of
  `MODEL_REGISTRY`.

Reused: `tolerantEnum` (live-state), `serveValue` external + file watcher (the `infra/deps` live.ts
pattern), `defineDataDir`, `defineJob` schedule (the `cost/refresh-job.ts` shape),
`requireClaudeBin` / the probe env (`claude-cli/availability`), `spawnCaptured` (`infra/spawn`),
`dynamicEnumField`, `shell/notifications`, and `recordReport`.

## Rollout order

1. Spike: reading the CLI's menu without a model call (the `initialize` request above).
2. The id-format types and `modelMeta`, with every call site migrated. The catalog is just
   `BASELINE_MODELS`, so behaviour is identical and tsc drives the churn.
3. The catalog plugin (data dir, live value, discovery job, CLI-version trigger) and
   `resolveModel(choice, catalog)`.
4. Config and pickers (dynamic options, the `visibleModels` record).
5. Retirement from the menu, `assertChoiceLaunchable`, `ModelUnavailableError`, and the MCP schema.
6. Rewrite the release recipe in model-provider's CLAUDE.md: "nothing to do; a new *family* is one
   `FAMILY_META` entry".

## Verification

- **Unit tests** (`./equin test plugins/conversations/plugins/model-provider`):
  - the id format and date-suffix parsing (`claude-haiku-4-5-20251001` → `haiku-4-5`);
  - `modelMeta` labels;
  - `resolveModel` against catalogs where the current version moved, a pin is retired, or the id is
    unknown;
  - a stored well-formed but unknown id is *not* reported, and a malformed one is;
  - the menu parser, fed a recorded `initialize` response (account stripped), schema drift, and the
    discovery transitions (new, moved, retired, un-retired, unknown alias, missing family), plus a
    fake-`claude` script proving the argv and stdin (precedent: `availability/probe.test.ts`).
- **End to end, simulating a release without code:**
  - Edit the test machine's `catalog.json` by hand to set `current.sonnet = "sonnet-9"` (or point
    `CLAUDE_BIN` at a fake whose `initialize` menu resolves `sonnet` to `claude-sonnet-9`).
  - Then check:
    - every picker in the running app updates without a reload ("Sonnet · 9");
    - the bell notification fires;
    - a new conversation launched with "Sonnet" records `sonnet-9` in `conversations.model`
      (`query_db`) and passes `--model claude-sonnet-9`.
  - Screenshot with `e2e-harness/e2e/screenshot.ts --path /settings…`.
- **Retirement:** drop a pinned id from a fake CLI's menu (or mark it retired by hand), then check that it disappears from pickers, and that
  an auto-start task pinned to it fails with the "retired" message, not a silent substitute.
- **Real run:** trigger `models.discover` via Run now in Debug → Background activity. The catalog
  should match the menu verified above (fable 5.1, opus 5.5, sonnet 5.5, haiku 4.5), with nothing
  retired.
- Run `./equin check`. `model-provider:no-raw-model-flags` still passes: the only flag
  literals left are the family aliases, not `claude-<tier>-<digit>`.
