# claude-cli/availability

Can this machine run an agent right now? Every agent and every one-shot
generation is an Agent SDK session (`infra/claude-cli/sdk`) on the Claude Code
build the SDK ships — installed with the app's dependencies, never by the user —
so the answer is whether the computer is **signed in**. The user signs in from
the app (`claude-cli/sign-in`), never from a terminal.

## The status

`ClaudeCodeStatus` (core) — `ready` / `signed-out` / `unreadable`.
`unreadable` means the check itself failed (timeout, crash, unexpected output,
the bundled build not installed — a broken install, not a user state): it is
rendered as "can't tell", never as a verdict.

The probe (`server/internal/probe.ts`) opens one Agent SDK session on the
system account (the computer's own login) that reads its `initialize` answer —
the version and the signed-in account — and closes (`readClaudeInitialize`;
no turn, nothing billed). It runs under `claudeSessionEnv`'s host facts, the
same closed environment every session gets.

## Freshness — no polling

The answer is cached per backend (`server/internal/status.ts`) and pushed as
the `claude-code-status` value — the `claudeCodeStatus` `liveValue` (core),
served on the external arm as `claudeCodeStatusServed`
(`machine/internal/status-served.ts`), notified whenever a probe's answer
differs from the last one. There is no placeholder: until the first check
lands, readers see `pending`.

The value and the recheck endpoint are declared `needsMachine` ("Checking
Claude Code") and served from `machine/` — the probe is the computer's login —
while the gate API (`assertClaudeCodeReady`, `recheckClaudeCodeNow`, …) stays in
`server/`, which other plugins' server code imports. Under a host without the
computer (the demo's browser worker) every reader handles `unavailable`: the
health row is `unknown` with the sentence, Check again is disabled with it as
its tooltip, and `useClaudeCodeLaunchBlock()` adds no block (Launch is gated on
the launch endpoint's own availability). It is re-asked:

- on first read (lazy — nothing probes at boot);
- by the launch gate, when the last answer is not `ready` (none yet, or a
  block — so a sign-in elsewhere is seen at once);
- on `POST /api/claude-code/recheck` (the health row's Check again);
- when the user returns to the window while it is blocked (`RecheckOnReturn` —
  the login can change outside the app);
- when an in-app sign-in finishes (`claude-cli/sign-in` calls
  `recheckClaudeCodeNow()`);
- after evidence: a one-shot generation failing (`noteClaudeCodeFailure`).

A `ready` answer is never re-probed for its age. The probe reads one
`initialize` answer, and every agent's own Claude Code answers the same
`initialize` seconds later, on the launch's path (the launch waits for it):
the agent checks it (`statusOfInitialize`, core) and, signed out, ends before
`ready` — the launch fails with `claudeCodeBlockMessage`, and the start
failure re-probes (`noteClaudeCodeFailure`) so the next launch is refused up
front. A TTL re-probe here started a second Claude Code (1–4 s) on every
launch and resume after five quiet minutes, to ask what the agent was about to
answer anyway.

`~/.claude.json` is deliberately not watched: every running agent rewrites it
constantly, and login state lives in the macOS Keychain anyway.

## The launch gate asks about the launch's account

An agent runs on the active Claude account (`infra/claude-cli/accounts`), so
the gate every launch path asks — `checkLaunchReadiness()` — is about that
account, not about the computer:

- the **system account** (the computer's own login): the probe's status above;
- an **added account** (a plan token or an API key): `ready`, with no probe. It
  brings its own credential, handed to Claude Code in the agent's environment
  with every other one removed, so the computer being signed out plays no
  part. A probe could not vouch for it anyway: `initialize` only says a
  credential is present. The agent's own start is the check — a credential
  Claude Code refuses ends the agent before `ready`, failing the launch with
  the reason.

Switching the active account to an added one wakes the launches the computer's
sign-in held back: the machine half watches the accounts file
(`watchClaudeAccounts`) and `noteActiveAccountChanged` runs the
`onClaudeCodeReady` listeners. The web's `useClaudeCodeLaunchBlock()` follows
the same rule. The health row and model discovery keep asking about the
computer's login — that is what they are about.

## What consumers use

- `assertClaudeCodeReady()` — the first thing every launch and resume path does,
  before anything is written (over `checkLaunchReadiness()`). Throws `ClaudeCodeUnavailableError`, an
  `HttpError(409)` whose message carries the fix, so every endpoint answers with
  it without knowing about it. Resume paths and the auto-start queue use
  `checkLaunchReadiness()` and return the `claude-code-unavailable`
  resume-blocked reason / leave the task armed instead. `checkClaudeCode()` is
  the computer's own status (model discovery reads it).
- `onClaudeCodeReady(fn)` — runs when a blocked launch can run again: the
  status turns `ready` after a block, or an added account is made active.
  The auto-start queue leaves tasks armed while blocked; tasks/server re-runs its
  armed-task reconcile on this.
- web: the health report's **Claude Code** row (critical while signed out, with
  the in-app sign-in), `useClaudeCodeStatus()`, and
  `useClaudeCodeLaunchBlock()` — the reason a launch control disables itself,
  only for a KNOWN block (loading or unreadable leave it enabled; the server
  gate decides).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Claude Code availability, shown: the pieces of the health report's Claude Code row (useClaudeCodeHealth — critical while the computer is signed out — ClaudeCodeDetail with Claude Code's own note, ClaudeCodeActions' Check again; the row itself is the sdk runtime's, which adds the in-app sign-in, the Agent SDK and the running agents), useClaudeCodeLaunchBlock() for launch controls to disable themselves with where to sign in, and a re-check when the user returns to the window while it is blocked. Claude Code availability: probes whether the computer is signed in to Claude Code (the build the Agent SDK ships — one session on the computer's own login reading its initialize answer: version and account, no turn; the machine half serves the answer as the claude-code-status push value and POST /api/claude-code/recheck) and gives every launch path checkLaunchReadiness() / assertClaudeCodeReady() — asked about the account the launch runs on (the computer's login is checked only for the system account; an added plan token or API key brings its own credential) — so an agent that cannot run is refused up front, pointing at the in-app sign-in. onClaudeCodeProbed hands every fresh answer to work keyed off the Claude Code version (which moves only with an SDK upgrade).
- Web:
  - Contributes: `Core.Root` → `RecheckOnReturn`
  - Uses:
    - `infra/endpoints.FetchEndpoint`
    - `infra/endpoints.useFetchEndpoint`
    - `infra/endpoints.useMachineAvailability`
    - `network/live.useLive`
    - `network/live/live-state.foldResource`
    - `network/live/live-state.ResourceErrorInline`
    - `primitives/icon-button.IconButton`
    - `primitives/setup-steps.StepNote`
  - Exports (values):
    - `ClaudeCodeActions`
    - `ClaudeCodeDetail`
    - `useClaudeCodeHealth`
    - `useClaudeCodeLaunchBlock`
    - `useClaudeCodeStatus`
- Server:
  - Contributes: `resource.declare` "claude-code-status"
  - Uses:
    - `infra/claude-cli/accounts.activeClaudeAccountId`
    - `infra/claude-cli/sdk.claudeSessionEnv`
    - `infra/claude-cli/sdk.readClaudeInitialize`
  - Exports (types): `LaunchReadiness`
  - Exports (values):
    - `assertClaudeCodeReady`
    - `checkClaudeCode`
    - `checkLaunchReadiness`
    - `ClaudeCodeUnavailableError`
    - `noteClaudeCodeFailure`
    - `onClaudeCodeProbed`
    - `onClaudeCodeReady`
    - `recheckClaudeCodeNow`
  - Resources: `claude-code-status` (push, notified)
- Machine:
  - Uses:
    - `infra/claude-cli/accounts.watchClaudeAccounts`
    - `infra/endpoints.implementMachine`
    - `network/live.serveValue`
  - Routes: `POST /api/claude-code/recheck`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
  - Exports (types):
    - `ClaudeCodeBlock`
    - `ClaudeCodeStatus`
  - Exports (values):
    - `claudeCodeBlockMessage`
    - `claudeCodeProblem`
    - `claudeCodeStatus`
    - `ClaudeCodeStatusSchema`
    - `recheckClaudeCode`
    - `statusOfInitialize`
- Cross-plugin:
  - Imported by:
    - `apps/agent-manager/welcome`
    - `apps/home/new-app`
    - `apps/sonata/transcription`
    - `conversations`
    - `conversations/agents`
    - `conversations/model-provider/catalog`
    - `conversations/runtime-sdk`
    - `infra/claude-cli`
    - `infra/claude-cli/sign-in`
    - `primitives/launch`
    - `tasks`
    - `tasks/task-triage`
- Exemptions:
  - Exempts itself from: `page-hosts-on-demand` — `web/index.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
