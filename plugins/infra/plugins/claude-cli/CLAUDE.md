# claude-cli

One-shot Claude generations. Each call is one Agent SDK turn (`runClaudeTurn`,
`plugins/sdk`) that returns the result's text. Use for short, latency-tolerant
generations (titles, summaries, classifications) where spinning up a full
conversation would be overkill.

It runs on the **active Claude account** (`activeClaudeAccountId`,
`plugins/accounts`) — the one new agents launch on — under the host facts alone
(`claudeSessionEnv`). Nothing here spawns `claude` by hand: the `claude-sdk`
lint rules reject a direct SDK `query()` and a spawn of the executable.

The executable is the Claude Code build the Agent SDK ships (`plugins/sdk`);
whether the computer is signed in to it comes from the `availability`
sub-plugin (`plugins/availability/CLAUDE.md`), which also shows it in the
health report, and the user signs in from the app (`plugins/sign-in`).

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

Throws `ClaudeCliError` on an error result (a usage limit, in Claude Code's own
words), a CLI that died, or a timeout.

### Read-only structured runs

`runClaudeReadOnly({ tier, prompt, system?, readDir, output, timeoutMs, source })`
is a turn that may LOOK at code but never change it (`readOnlyOptions`): tools
exactly `READ_ONLY_TOOLS` (Read, Grep, Glob), `--restricted` (no code-running
tools, file tools confined to `readDir`), no setting sources, `strictMcpConfig`,
`permissionMode: "dontAsk"`, cwd `readDir`. `output` is a zod schema: it is
the session's `outputFormat` (draft-07 JSON schema) and the result's
`structured_output` is parsed with it — one declaration, so the two cannot
disagree. Throws `ClaudeCliError` on an error result or an answer outside the
schema. Used by the sidequest autopilot's triage. Callers that need graceful degradation should `try/catch` and fall back.

`timeoutMs` is a real ceiling (`runClaudeTurn`): past it the session is aborted
and the await rejects through `withDeadline`, whether or not the SDK's stream
ever settles — the guarantee `spawnCaptured` once gave the hand-spawned CLI
against bun's exit-during-stream-pull race.

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
- Anything that needs streaming. This helper returns the whole result.
- Hot loops. Each call starts a new Claude Code process (~1-2s startup).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Consumer half of the claude-cli call log: useClaudeCliCalls({correlationId, occurredAt}) answers 'which model calls produced this record?' as a calls / none / not-retained result, <ClaudeCliCallDetail> is the one rendering of a recorded call (header, meta grid, context with id chips, output or error, prompt, system — each copyable), and SLOW_CALL_MS is the duration past which a call reads as slow. One-shot Claude generations for short, latency-tolerant work (runClaudePrint), and runClaudeReadOnly — a turn that may only Read / Grep / Glob one directory and answers with a zod-schema'd structured value. Each is one Agent SDK turn (infra/claude-cli/sdk) on the active Claude account — the one new agents launch on — recorded in the call log.
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
    - `infra/claude-cli/accounts.activeClaudeAccountId`
    - `infra/claude-cli/availability.noteClaudeCodeFailure`
    - `infra/claude-cli/sdk.ClaudeQueryInput`
    - `infra/claude-cli/sdk.claudeSessionEnv`
    - `infra/claude-cli/sdk.ClaudeTurnError`
    - `infra/claude-cli/sdk.ClaudeTurnResult`
    - `infra/claude-cli/sdk.runClaudeTurn`
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
    - `claude-cli.calls-for` (push, capped: RECENT_CALLS_LIMIT, whole: the caller's label for the call — a few named values it chose (a source id, a url))
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
    - `fields/duration/config.durationField`
    - `fields/json/config.jsonField`
    - `fields/text/config.enumTextField`
    - `fields/text/config.parsedTextField`
    - `fields/text/config.textField`
    - `fields/uuid/config.uuidField`
    - `infra/entities.entityRef`
    - `network/live.liveCollection`
    - `network/live.LiveRowsCollection`
    - `network/live.liveValue`
    - `packages/list-bound.cappedList`
    - `packages/list-bound.wholeRecord`
  - Exports (types):
    - `ClaudeCliCall`
    - `ClaudeCliCallRow`
    - `ClaudeCliCallsResult`
    - `ClaudeCliCallStatus`
  - Exports (values):
    - `claudeCliCallFields`
    - `claudeCliCalls`
    - `ClaudeCliCallSchema`
    - `claudeCliCallsEntityRef`
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
    - `apps/places/places-core`
    - `debug/claude-cli-calls`
- Exemptions:
  - Exempts itself from:
    - `ids:pk-declared` — `server/internal/tables.ts` (debt)
    - `investigate:failures-registered` — `core/resources.ts` (sanctioned)
- Sub-plugins:
  - **`accounts`** — The Claude accounts' credentials, every host's half: each added account's plan token or API key in the secrets store — saved, deleted, and read by the agent at its start (claudeAccountCredential…
  - **`availability`** — Claude Code availability, shown: the pieces of the health report's Claude Code row (useClaudeCodeHealth — critical while the computer is signed out — ClaudeCodeDetail with Claude Code's own note…
  - **`sdk`** — The one way a backend opens a Claude Code session: through the Agent SDK, on an account its caller chose. claudeSessionEnv(account) is the environment (the host facts plus an added account's…
  - **`sign-in`** — Signing in to Claude from the app, shown: the Claude Code row's pieces (ClaudeCodeSignInRemedy — the Sign in split button: Claude subscription / Anthropic Console / Single sign-on…

<!-- AUTOGENERATED:END -->
