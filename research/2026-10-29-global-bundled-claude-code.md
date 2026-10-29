# Run Claude Code from the Agent SDK's bundled build, signed in from the app

Follow-up to `2026-10-28-global-claude-sdk-everywhere.md` (its out-of-scope item
"Using the SDK's bundled Claude Code instead of the installed one").

## Context

Every Claude Code session goes through `claudeQuery` (`infra/claude-cli/sdk`),
but each one is still handed the user's installed `claude`
(`requireClaudeBin()` → `pathToClaudeCodeExecutable`). This causes three problems:

- **Version skew.** The SDK is pinned in `bun.lock` (0.3.310 ↔ CLI 2.1.310), but
  the installed CLI updates itself (2.1.308 here today). The
  `runtime-sdk.bundled-cli` health check only exists to flag that drift.
- **Unreviewed upgrades.** A Claude Code self-update reaches running agents
  without going through build or checks.
- **An install prerequisite.** The `missing` availability state, the
  `curl … install.sh` fix and doctor.sh's Claude section exist only because of it.

Goal: equin runs only the Claude Code build pinned through `bun.lock`, and
**sign-in happens in the app**. The user never runs a CLI. The CLI is for
humans working on the repo, never a user-facing fix.

## What was verified (2026-10-29, read-only)

- **Delivery.** The binary ships in an optional per-platform npm package,
  `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` (a 274 MB native `claude`,
  installed by `bun install`, cloned per worktree on APFS). There is no download
  on first use and it works offline. `extractFromBunfs` is only for apps built
  with `bun build --compile`, so it does not apply here. The SDK resolves the
  binary by `require.resolve("@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude")`
  from its own location (it tries `-musl` first on musl Linux). It does not
  export this resolver. The package is not hoisted into our workspaces, so we
  must resolve it from the SDK's own entry.
- **Same login.** The bundled `claude auth status --json` reports
  `loggedIn: true, subscriptionType: max` from the same keychain and `~/.claude`.
  Existing sign-ins carry over and nobody has to sign in again.
- **Same signing identity.** Both binaries are `com.anthropic.claude-code`, team
  `Q6L2SF6YDW`, with an identical designated requirement, on the same volume as
  `~/.equin`. The per-conversation hardlink path does not change
  (`named-claude.ts` relinks the same name to the current binary on every
  start), so existing TCC grants should still apply. A re-prompt is possible
  only if TCC pinned a cdhash. This needs checking on one live conversation
  (see Verification).
- **No SDK login API.** The SDK has no login or OAuth control request. Signing in
  means running the bundled binary's `auth login` or `setup-token`, which take
  `--claudeai`/`--console`/`--sso`/`--email`.

## Phase 0: Prototype first (UI) + login spike (tech), in parallel

**Prototype** `claude-sign-in` (in `~/.equin/apps/prototypes/`, from `_template/`,
mocking the health report's Claude Code row and the Claude accounts section):

1. The **signed-out** row: "Claude Code is not signed in" with a **Sign in**
   button, replacing the copy-this-command step.
2. **Sign-in in progress:** "Finish signing in in your browser" with an *Open
   page again* link (the URL), a *Paste code* field for when the browser is on
   another machine or the callback fails, and Cancel.
3. **Done:** the row turns ready and shows the email and plan. **Failed:** the
   CLI's message plus Try again.
4. **Add account** (Claude accounts section): **Sign in another account**
   runs `setup-token` in-app and saves the token directly. The flow has the
   same states as 1–3, and *Paste a token or API key* stays as the secondary
   path for API keys.

**Spike** (throwaway script, answers whether the flow is feasible): run the
bundled `claude auth login` and `claude setup-token` as children **without a
TTY**, using a scratch `CLAUDE_CONFIG_DIR` so the real login is untouched.
Questions to answer:
- Does it print the authorize URL on stdout/stderr in a parseable form?
- Does the localhost callback complete the flow by itself?
- Does it accept the pasted code on stdin?
- Does `setup-token` print the `sk-ant-oat…` token where we can capture it?
- Does `--console` behave the same?

If either command refuses to run without a TTY, the fallback is a pty
(`script -q /dev/null …` on macOS, no new dependency) and the parsing stays the
same. The spike's result decides the stream protocol below. The UI stays as
the prototype shows it, whichever answer we get.

Implementation starts only once the prototype is reviewed.

### Spike results (2026-10-29, bundled 2.1.310, scratch `CLAUDE_CONFIG_DIR`, no TTY)

- **`auth login` runs without a TTY.** About 300 ms after start it prints:
  `Opening browser to sign in…\nIf the browser didn't open, visit: <URL>\nPaste code here if prompted > `
  - The printed URL is the **manual** flow: `redirect_uri=https://platform.claude.com/oauth/code/callback`,
    so the page shows a code to paste, which the CLI reads from stdin.
  - It also **listens on `127.0.0.1:<random port>`** and opens a second URL with
    `redirect_uri=http://localhost:<port>/callback`, which completes on its own.
  - `--console` behaves the same against `platform.claude.com/oauth/authorize`.
- **`BROWSER` is honored.** With `BROWSER=<recorder script>`, the CLI hands the
  localhost-callback URL to that script instead of opening a browser. So the
  machine half sets `BROWSER` to a tiny shim that writes the URL to a fifo or
  file it watches. It then publishes the URL as `waiting.url` and opens it in
  the user's browser itself. *Open the page again* re-opens the same URL. The
  pasted code is for *Signing in on another device*, using the printed manual
  URL.
- **`setup-token` prints nothing** (neither without a TTY nor under
  `script -q /dev/null` within 5 s). It still listens on localhost and hands
  `BROWSER` its URL (`scope=user:inference`, the long-lived token). **Still
  open:** how it emits the token on success. This can only be checked by
  completing one real sign-in. That is the first implementation step for the
  add-account flow. If the token isn't capturable, the fallback is `auth login`
  under a per-account scratch `CLAUDE_CONFIG_DIR`, reading the token back.

## Phase 1: One bundled binary

**`infra/claude-cli/sdk` (server):** `bundledClaudeBin(): string` resolves the
platform package from the SDK's entry (`createRequire(import.meta.resolve(
"@anthropic-ai/claude-agent-sdk"))`, the same name order as the SDK including
`-musl`). It throws loudly when the package is absent: an optional dependency
skipped on an unsupported platform or a broken install is a deployment bug,
not a user state.

- `claudeQuery` / `readClaudeInitialize`: drop the required `bin`. They spawn
  `bundledClaudeBin()` themselves. The one exception becomes an optional
  `link?: string`, a hardlink to the bundled binary that `runtime-sdk` makes
  (rung 1: no caller can name any other binary). The usage probe, run-claude-print,
  availability probe and catalog `readCliModels` stop passing a bin.
- `claudeSessionEnv`: set `DISABLE_AUTOUPDATER=1`, so the pinned build can
  never try to update itself.
- Lint `no-claude-bin-spawn`: retarget it from `requireClaudeBin` /
  `resolveClaudeBin` to `bundledClaudeBin`, and update its test cases.

**Delete the lookup:** remove `resolveClaudeBin`, `CLAUDE_CANDIDATES` and
`ClaudeBinLookup` (`infra/paths/server/internal/bins.ts`), `requireClaudeBin`
(`availability/server/internal/status.ts`), the `CLAUDE_BIN` env name
(`launcher/env-names`), and the `paths` check hint that mentions it.

**`runtime-sdk`:** `sdk-runtime.ts` passes `bundledClaudeBin()` to
`namedClaudeBin`, and the comments stop calling it "the system claude"
(`core/protocol.ts:277`, `named-claude.ts`'s updater note). `agent.ts` is
unchanged: it already spawns whatever path its options carry.

**Drift check goes away:** delete `runtime-sdk.bundled-cli` (`core/cli-version.ts`,
`machine/internal/bundled-cli.ts`, the `sameMajorMinor` branch in
`web/internal/claude-code-row.ts`, and the `browser-host.generated.ts` entry,
which regenerates). The version shown is `ready.version` from initialize,
which is now the pinned version by construction.

**Model catalog:** no code change. `onClaudeCodeProbed` still fires the
discover job on a new version, which now happens only when an SDK upgrade lands
through build. Update the "every new Claude CLI version" wording.

**doctor.sh:** drop the Claude Code section and its `doctor.test.ts`
assertions. It runs before `bun install`, so the binary isn't there yet, and
sign-in is the app's job now.

## Phase 2: Availability states

`ClaudeCodeStatus` (`availability/core/internal/status.ts`):
- Drop `missing` and `CLAUDE_CODE_FIX.install`. A failure in `bundledClaudeBin()`
  inside the probe surfaces as `unreadable` with its message, and is reported.
- `signed-out` keeps its kind. `claudeCodeFixCommands` / `claudeCodeBlockMessage`
  stop printing shell commands. The launch refusal says "Claude Code is not
  signed in. Sign in from the Claude Code row in the health report." A row
  action is preferred over a command (rung 1: there is no command left to
  copy wrong).

## Phase 3: In-app sign-in (after prototype review, protocol from the spike)

New sub-plugin **`infra/claude-cli/plugins/sign-in`**:
- **machine:** one login flow at a time, run as a child of the bundled binary
  (`auth login [--console|--sso]` for the computer, `setup-token` for an added
  account). It is published as a live value `claude-sign-in.flow`:
  `{ kind: "idle" } | { kind: "waiting", url, target } | { kind: "done", … } |
  { kind: "failed", error }`. Push-based: the state is derived from the child's
  output and exit, with no polling.
- **Endpoints:**
  - `POST /api/claude-sign-in/start { target: "computer" | "new-account", method }`
  - `POST …/code { code }`, which writes the code to the child's stdin
  - `POST …/cancel`
  When a `setup-token` flow ends, its token goes straight to
  `saveClaudeAccountCredential` (`accounts/server`) and is never shown. When an
  `auth login` flow ends, it calls `recheckClaudeCodeNow()` so the health row
  flips through `onClaudeCodeReady`, and armed auto-start tasks resume.
- **web:** the flow component from the prototype. The health row's signed-out
  state (`runtime-sdk/web/internal/claude-code-row.ts`) and the Claude accounts
  section (`runtime-sdk/web/components/claude-accounts.tsx`, which replaces the
  `claude setup-token` StepCommand) render it. The URL opens through the
  existing external-link affordance.
- Update the `accounts/CLAUDE.md` and `availability` descriptions so they no
  longer mention `claude auth login` or `claude setup-token` as user steps.

## Files (representative)

- `plugins/infra/plugins/claude-cli/plugins/sdk/server/internal/session.ts` (+ new `bundled-bin.ts`), `lint/no-claude-bin-spawn.ts`
- `plugins/infra/plugins/claude-cli/plugins/availability/{core,server}/internal/{status,probe}.ts`
- `plugins/infra/plugins/claude-cli/server/internal/run-claude-print.ts`
- `plugins/infra/plugins/paths/server/internal/bins.ts`, `plugins/infra/plugins/launcher/plugins/env-names/core/internal/env-keys.ts`
- `plugins/conversations/plugins/runtime-sdk/machine/internal/{sdk-runtime,usage-probe,named-claude,bundled-cli}.ts`, `core/cli-version.ts`, `web/internal/claude-code-row.ts`, `web/components/claude-accounts.tsx`
- `plugins/conversations/plugins/model-provider/plugins/catalog/machine/internal/{cli-models,discover-job}.ts`
- `plugins/framework/plugins/cli/plugins/doctor/{doctor.sh,cli/doctor.test.ts}`
- new `plugins/infra/plugins/claude-cli/plugins/sign-in/`

## Verification

- `./equin test` on claude-cli (sdk, availability, lint rules), runtime-sdk,
  catalog, doctor, and sign-in (pure tests over the output→state parser).
- `./equin check` (the lint rule fires on a deliberate spawn of `bundledClaudeBin()`).
- `./equin build`, then:
  - the health row shows `ready` at **2.1.310** (the pinned version, not the
    installed 2.1.308);
  - Debug → Claude CLI calls shows a fresh title call;
  - `ps` shows agents' `claude` resolving to the node_modules inode;
  - launching with `~/.local/bin` off PATH still works.
- **TCC:** relaunch an existing conversation that already had a permission
  granted, and check for a re-prompt. Report the result either way.
- **Sign-in:** with a scratch `CLAUDE_CONFIG_DIR` in a worktree build, the row
  shows signed-out, then Sign in, then browser, then ready, with no terminal
  involved. Run the paste-code path and Cancel once. Add an account through the
  in-app `setup-token` and check that it lands in the accounts list and
  launches an agent.

## Outcome (2026-10-29, implemented)

- Phases 1–3 landed as planned. Deviations:
  - `claudeQuery`'s `bin` is optional rather than replaced by a `link`: every
    session omits it and the SDK runs its bundled build. Only the sdk runtime's
    agent names the file: `bundledClaudeBin()` (new `claude-cli/sdk/machine`) or
    its per-conversation hardlink.
  - The agent's `claudeBin` is resolved by `startAgentProcess` at **every**
    start (`AgentLaunchIntent` = the options minus the per-start fields).
    Without this, a relaunch from an existing launch.json would have kept
    running the installed `claude`.
  - `install.sh` and `docs/setup.md` no longer install Claude Code or sign in
    from a terminal.
  - Added accounts sign in with Claude subscription only:
    `setup-token --help` (2.1.310) takes no `--console`. Console billing goes
    through "Use an API key".
- Verified on the build: the health row shows v2.1.310 (installed: 2.1.308).
  A direct `readClaudeInitialize` + `runClaudeTurn` resolved the bundled
  binary with `DISABLE_AUTOUPDATER=1` and completed a turn.
- **Still to verify (needs the user):**
  - one real in-app sign-in, both computer and added account (how
    `setup-token` prints its token: `parseSetupToken` in
    `sign-in/machine/internal/cli-output.ts`);
  - whether an existing conversation's macOS grants survive its first relaunch
    onto the bundled binary.
