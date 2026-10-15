# claude-cli

One-shot Claude CLI helper. Spawns `claude --print` and returns stdout. Use for short, latency-tolerant generations (titles, summaries, classifications) where spinning up a full conversation would be overkill.

Auth is the user's local Claude login — no API keys, no SDK dependency.

The executable comes from `requireClaudeBin()` and whether it is installed and
signed in from the `availability` sub-plugin (`plugins/availability/CLAUDE.md`),
which also shows it in the health report. A missing CLI is not reported as a
crash of the caller — the health row already says so.

## Usage

```ts
import { runClaudePrint } from "@plugins/infra/plugins/claude-cli/server";

const title = await runClaudePrint({
  model: "haiku",
  prompt: "Refactor the gateway to use a worker pool",
  system: "Output a short imperative title (max ~60 chars). No quotes, no period.",
  timeoutMs: 10_000,
});
```

Throws `ClaudeCliError` on non-zero exit or timeout.

### Read-only structured runs

`runClaudeReadOnly({ tier, prompt, system?, readDir, output, timeoutMs, source })`
is a print that may LOOK at code but never change it: the CLI gets exactly
`--tools Read,Grep,Glob` (`READ_ONLY_TOOLS`), `--restricted` (no code-running
tools, file tools confined to `readDir`, user/project settings ignored),
`--strict-mcp-config`, `--permission-mode dontAsk`, cwd `readDir`. `output` is
a `zod/v4` schema: it is handed to the CLI as `--json-schema` and the
`structured_output` is parsed with it — one declaration, so the two cannot
disagree. Throws `ClaudeCliError` on an error result or an answer outside the
schema. Used by the sidequest autopilot's triage. Callers that need graceful degradation should `try/catch` and fall back.

The child goes through `spawnCaptured` (`infra/spawn`), **never** a raw
`Bun.spawn` with piped stdio: bun 1.3.13's exit-during-stream-pull race leaves the
pull promise unsettled when the child exits, and `proc.kill()` cannot rescue a
child that is already dead — a caller parks forever with no error, no call-log
row, and no failed run. `timeoutMs` is a real ceiling only because of that.

## Correlation — "which model calls produced *this* record?"

`source.correlationId` stamps a recorded call with the domain record it was made
for, so a feature plugin can reach the prompt/output that explain that row:

```ts
await runClaudePrint({ tier: "sonnet", prompt,
  source: { name: "events.url-extract", correlationId: ctx.runId, context: { sourceId, url } } });

// ResourceResult<ClaudeCliCallsResult>; pass null until the record is loaded
const calls = useClaudeCliCalls({ correlationId: run.id, occurredAt: run.startedAt });
```

It must be a **globally unique row id** (a UUID): the column is not namespaced by
`source.name`, so a per-caller ordinal would hand one plugin another's prompts.
`context` is the Debug pane's label; `correlationId` is the key.

`claudeCliCallsFor` (`core/resources.ts`, a `liveValue` keyed
`claude-cli.calls-for`, params `correlationId` and an optional ISO
`occurredAt`; served `source: "db"` over `claude_cli_calls`, so a call recorded
or trimmed while a reader watches is pushed) answers **`calls`** /
**`none`** (never called — the right answer for a cache hit that skipped the
expensive phase) / **`not-retained`** (called, but the log trimmed it). A bare
`[]` would render "no model call" over a record whose prompt merely aged out.

`not-retained` needs BOTH halves — the log is trimmed to `RECENT_CALLS_LIMIT`
rows *globally*, so trimming is only possible at capacity:

1. `count(*) >= RECENT_CALLS_LIMIT` — without it a fresh install libels every
   record older than the first call ever made.
2. `occurredAt < min(created_at)` — a call is at or after its record's instant,
   so a record older than every survivor cannot have a surviving call.

An omitted `occurredAt` makes (2) untestable, so an empty result reports `none`.

`<ClaudeCliCallDetail call={…} />` (`…/claude-cli/web`) is the one rendering of a
call — header (source, model, outcome), meta grid (started, duration, model id,
call id, correlation), the source context (its `task-…` / `conv-…` values render
through `<InlineText>`, so as the registered id chips), then output or error,
prompt and system, each with its size and a copy button — so consumers don't
each re-render prompts. Callers supply their own chrome (pane, card, inset):
Debug → Claude CLI Calls' detail pane and an event run's Model call section
both compose it.

Debug → Claude CLI Calls lists the log through `claudeCliCalls`
(`core/resources.ts`, key `claude-cli-calls`), a `liveCollection` over
`claude_cli_calls` backing a live DataView (key-range pages): newest first,
100 rows by default, grown up to `RECENT_CALLS_LIMIT` — the recorder's own
trim, so a fully grown window is the whole log (and a `contains` search over
the prompt text scans at most that many rows). Search runs over
`sourceName` / `prompt` / `output` / `error`; `sourceName` and `model` are the
Source / Model facets (a grouping of the whole log); `durationMs` and
`createdAt` filter and sort. The row carries one computed field, `status`
(`"ok"` / `"error"`): `claudeCliCallsServed` binds it to the SQL expression
`error IS NOT NULL` (an `expr` column), so the Status filter and group-by run on
the server and the field can never disagree with `error`. The list row type is
`ClaudeCliCallRow` (= `ClaudeCliCall` + `status`); the per-record value and the detail
block keep taking a plain `ClaudeCliCall`.

## When NOT to use

- Anything that needs a real conversation (multi-turn, tool use). Use `createConversation` from `@plugins/conversations/server` instead.
- Anything that needs streaming. This helper buffers the full stdout.
- Hot loops. Each call spawns a new `claude` process (~1-2s startup).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Consumer half of the claude-cli call log: useClaudeCliCalls({correlationId, occurredAt}) answers 'which model calls produced this record?' as a calls / none / not-retained result, <ClaudeCliCallDetail> is the one rendering of a recorded call (header, meta grid, context with id chips, output or error, prompt, system — each copyable), and formatCallDuration is how a call's duration reads. One-shot Claude CLI helper (`claude --print`) for short, latency-tolerant generations, and runClaudeReadOnly — a print that may only Read / Grep / Glob one directory and answers with a zod-schema'd structured value. Reuses the user's local Claude CLI auth — no API key plumbing.
- Server:
  - Contributes:
    - `resource.declare` "claude-cli-calls"
    - `resource.declare` "claude-cli-calls:groups"
    - `resource.declare` "claude-cli-calls:rows"
    - `resource.declare` "claude-cli.calls-for"
    - `fork-data-exclusion` "claude_cli_calls"
  - Uses:
    - `conversations/model-provider/catalog.getModelCatalog`
    - `database.db`
    - `database/admin.ExcludeFromFork`
    - `database/sql-projection.parsed`
    - `infra/claude-cli/availability.ClaudeCodeUnavailableError`
    - `infra/claude-cli/availability.noteClaudeCodeFailure`
    - `infra/claude-cli/availability.requireClaudeBin`
    - `infra/entities.defaultNow`
    - `infra/entities.defaultRandom`
    - `infra/entities.defineEntity`
    - `network/live.serveCollection`
    - `network/live.serveValue`
  - DB schema: `plugins/infra/plugins/claude-cli/server/internal/tables.ts`
  - Exports (types):
    - `RunClaudePrintInput`
    - `RunClaudeReadOnlyInput`
  - Exports (values):
    - `_claudeCliCalls`
    - `ClaudeCliError`
    - `listCallsFor`
    - `READ_ONLY_TOOLS`
    - `runClaudePrint`
    - `runClaudeReadOnly`
  - Resources:
    - `claude-cli-calls` (keyed, window)
    - `claude-cli-calls:groups` (push)
    - `claude-cli-calls:rows` (keyed, point)
    - `claude-cli.calls-for` (push)
- Web:
  - Uses:
    - `conversations/model-provider.familyClass`
    - `network/live.useLive`
    - `primitives/copy-to-clipboard.CopyButton`
    - `primitives/css/badge.Badge`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/fill.Fill`
    - `primitives/css/grid.Grid`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Inset`
    - `primitives/css/spacing.Stack`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `primitives/css/yield.yieldClass`
    - `primitives/inline-text.InlineText`
    - `primitives/relative-time.RelativeTime`
  - Exports (values):
    - `ClaudeCliCallDetail`
    - `formatCallDuration`
    - `SLOW_CALL_MS`
    - `useClaudeCliCalls`
- Core:
  - Uses:
    - `conversations/model-provider.FALLBACK_MODEL`
    - `conversations/model-provider.StoredModelSchema`
    - `fields.FieldsRecord`
    - `fields.fieldsToZodObject`
    - `fields.nullable`
    - `fields/date/config.dateField`
    - `fields/int/config.intField`
    - `fields/json/config.jsonField`
    - `fields/text/config.enumTextField`
    - `fields/text/config.parsedTextField`
    - `fields/text/config.textField`
    - `fields/uuid/config.uuidField`
    - `network/live.liveCollection`
    - `network/live.LiveRowsCollection`
    - `network/live.liveValue`
  - Exports (types):
    - `ClaudeCliCall`
    - `ClaudeCliCallRow`
    - `ClaudeCliCallsResult`
    - `ClaudeCliCallStatus`
  - Exports (values):
    - `claudeCliCallFields`
    - `claudeCliCalls`
    - `ClaudeCliCallSchema`
    - `claudeCliCallsFor`
    - `ClaudeCliCallsResultSchema`
    - `ClaudeCliCallStatusSchema`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-code`
    - `ui/tokens/type-scale --font-weight-normal`
    - `ui/tokens/type-scale --line-height-code`
  - Imported by:
    - `apps/events/sources/source-detail/runs/model-call`
    - `apps/events/sources/url-extract`
    - `apps/pages/auto-icon`
    - `apps/places/places-core`
    - `conversations/conversation-category`
    - `conversations/conversation-view/turn-summary`
    - `debug/claude-cli-calls`
    - `tasks/sidequest-autopilot`
    - `tasks/task-title`
- Exemptions:
  - Exempts itself from:
    - `ids:pk-declared` — `server/internal/tables.ts` (debt)
    - `investigate:failures-registered` — `core/resources.ts` (sanctioned)
- Sub-plugins:
  - **`availability`** — Claude Code availability, shown: the health report's Claude Code row (critical while the CLI is missing or signed out, with the install / sign-in commands and Check again)…

<!-- AUTOGENERATED:END -->
