# Every Claude Code call through the Agent SDK, on the chosen account

## Context

A `task-title.short` job died with "You've hit your weekly limit" after the
user switched the active Claude account. Cause: picking an account only
reaches agent processes (`runtime-sdk/bin/agent.ts` hands the account's token
to the SDK as `CLAUDE_CODE_OAUTH_TOKEN`). Every other call spawns the `claude`
binary by hand with `pickHostEnv(process.env)` and no token, so it always runs
on the computer's own login:

| spawn site | what it runs |
| --- | --- |
| `infra/claude-cli/server/internal/run-claude-print.ts` (`invokeClaude`) | `claude --print …` (runClaudePrint: titles, summaries, icons, classify, url-extract) |
| `infra/claude-cli/server/internal/run-claude-read-only.ts` | `claude --print --output-format json --json-schema …` via `invokeClaude` (triage) |
| `infra/claude-cli/plugins/availability/server/internal/probe.ts` | `claude --version` + `claude auth status --json` |
| `conversations/model-provider/plugins/catalog/machine/internal/cli-models.ts` | `claude -p --input-format stream-json …` + a hand-written `initialize` control request |

The user's direction: no hand-driven Claude CLI anywhere; everything through
the Agent SDK, and one place that decides which account a call runs on.

## Design

### 1. `infra/claude-cli/plugins/sdk` — the one way to open a Claude Code session (server barrel)

```ts
claudeQuery({
  account: string,          // required: an account id (SYSTEM_ACCOUNT_ID = the computer's login)
  bin: string,              // the executable (requireClaudeBin(), a named hardlink, …)
  env?: Record<string, string | undefined>, // base env; default pickHostEnv(process.env)
  prompt: string | AsyncIterable<SDKUserMessage>,
  options: Omit<Options, "env" | "pathToClaudeCodeExecutable">,
}): Promise<Query>
```

- Builds `env = { ...base, CLAUDE_CODE_OAUTH_TOKEN?: claudeAccountToken(account) }`
  — the shared active-account environment. `account` is required, so a call
  that forgets the account choice does not type-check (rung 2).
- `bin` is a parameter, not looked up, so `availability` can use it without a
  cycle (availability → sdk → accounts; claude-cli/server → availability + sdk).
- Owns the `@anthropic-ai/claude-agent-sdk` dependency (package.json); runtime-sdk keeps its own for types.
- Plus `readClaudeInitialize({ account, bin, signal, timeoutMs })`: a no-prompt
  session (the usage-probe pattern), `await session.initializationResult()`
  → `{ claude_code_version, account, models }`, then close. The one read
  both the availability probe and the model menu need.

### 2. Accounts: the active id readable from `server/`

`server/` may not read the filesystem (`boundaries/no-platform-api`), so the
active id is the `ActiveClaudeAccount` host service (`accounts/server`,
`activeClaudeAccountId()`), provided by `accounts/machine` from the accounts
file. One-shots run on the **active** account — the one new agents launch
on, which auto-switch moves when an agent launch finds it full.

### 3. Migrate the call sites

- **runClaudePrint / runClaudeReadOnly** (`invokeClaude`): `claudeQuery` with
  `account: activeClaudeAccountId()`, `bin: requireClaudeBin()`, `model`,
  `systemPrompt`, `tools: []` (read-only: `READ_ONLY_TOOLS`, `permissionMode:
  "dontAsk"`, `strictMcpConfig`, `extraArgs: { restricted: null }`,
  `outputFormat: { type: "json_schema", schema: draft-7 }`), `maxTurns`,
  `persistSession: false`, `settingSources: ["user"]` (what `--print` loaded),
  `cwd`. Read the stream to the `result` message: success → `result` /
  `structured_output`; error subtype / `is_error` → `ClaudeCliError` with the
  CLI's message (a rate limit says so). The await is bounded by
  `withDeadline` (`packages/deadline`) + `abortController`, so the bun
  exit-during-pull race `spawnCaptured` was guarding against still cannot
  park a job. Call recording, `noteClaudeCodeFailure`, error reports unchanged.
  `parseStructuredResult` becomes a pure function over the result message.
- **Availability probe**: `readClaudeInitialize({ account: SYSTEM_ACCOUNT_ID,
  bin })` → `ready` (version, `authMethod` from `tokenSource`/`apiKeySource`,
  `email`), `signed-out` (no account — verified empirically against a
  signed-out config dir), `unreadable` (timeout / throw). Semantics unchanged:
  it is about the computer's login.
- **Model menu** (`readCliModels`): `readClaudeInitialize(...).models`; drop
  `INITIALIZE_REQUEST`/`INITIALIZE_ARGS` and the stdout parsing; keep the zod
  parse of the menu entries.
- **Usage probe** and **agent.ts**: switch to `claudeQuery` (agent passes its
  own `env: process.env` base and keeps `spawnClaudeCodeProcess`).

### 4. Enforcement (rung 3)

`infra/claude-cli/plugins/sdk/lint`:
- `no-direct-sdk-query` — a value import of `query` from
  `@anthropic-ai/claude-agent-sdk` outside this plugin is an error (type
  imports allowed).
- `no-claude-bin-spawn` — a spawn call (`spawn`, `spawnCaptured`,
  `Bun.spawn`, `execFile`, …) whose arguments reference `requireClaudeBin` /
  `resolveClaudeBin` is an error: the binary is only ever handed to `claudeQuery`.

### Out of scope (follow-ups)

- Renaming `infra/claude-cli` (and the `claude_cli_calls` log) now that no CLI is driven by hand.
- Probing availability on the active account instead of the computer's login.
- Using the SDK's bundled Claude Code instead of the installed one.

## Verification

- `./equin test` on claude-cli, availability, catalog, runtime-sdk (updated pure tests: structured-result parse, initialize mapping).
- `./equin check` (lint rules fire on a deliberate violation, then removed).
- `./equin build`, then: Debug → Claude CLI calls shows a fresh task title call succeeding on the active account; the Claude Code health row is `ready`; the model catalog's discover job runs clean.
- Signed-out mapping checked with a throwaway `CLAUDE_CONFIG_DIR`.
