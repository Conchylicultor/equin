# claude-cli/sign-in

Signing in to Claude from the app. The user never runs a command: the app
runs Claude Code's own sign-in (the build the Agent SDK ships,
`bundledClaudeBin()`), opens its page in the browser, and shows where it
stands. Plan: `research/2026-10-29-global-bundled-claude-code.md` (Phase 3).

## Two targets

- **`computer`** — the computer's own Claude Code login (the system account):
  `auth login` with the method the user picked (`CLAUDE_SIGN_IN_METHODS`:
  Claude subscription, Anthropic Console `--console`, Single sign-on `--sso`),
  under the default `CLAUDE_CONFIG_DIR`. On success the machine half calls
  `recheckClaudeCodeNow()` (`availability`): the health row flips through the
  `claude-code-status` push and armed auto-start tasks resume through
  `onClaudeCodeReady`. A re-check that still is not `ready` fails the run.
- **`new-account`** — another Claude account agents can run on: `setup-token`
  (a Claude subscription only, so the target has no method), under a scratch
  `CLAUDE_CONFIG_DIR` in the run's folder so the computer's login is out of
  reach. The printed token goes straight to `addClaudeAccountWithCredential`
  (`accounts/machine` → the secrets store): never logged, never in the live
  value, never shown. An API key is still pasted (the Claude accounts'
  "Use an API key").

## One run at a time — a new start cancels the running one

There is one sign-in per backend. `start` while one runs **cancels it** and
starts the new one, rather than refusing: every second start is the user
asking again (another method, Try again, a second tab), and a refusal would
leave them stuck behind a run they abandoned. Each run has an `id`; `code` and
`cancel` name it, so a tab that saw an older run cannot reach a newer one
(`code` answers 409). `cancel` also dismisses a finished or failed run (the
flow reads `idle`). A run lives until it ends, is cancelled or replaced, or
the backend exits (its child dies with it; a backend killed mid-run leaves its
folder, which the next start sweeps — see below).

## The flow value — `claude-sign-in.flow`

`idle` | `waiting { id, target, url, manualUrl }` | `done { id, target,
accountId? }` | `failed { id, target, error }`, a `needsMachine` push value
served external + notified from the machine half's memory
(`machine/internal/flow-state.ts`). No polling anywhere:

- Claude Code's stdout and stderr are one **file descriptor** onto
  `<run>/output` (never a pipe — `infra/spawn`'s wedge); `$BROWSER` is a shim
  (`<run>/browser.sh`) that appends the page Claude Code asks to open to
  `<run>/browser-url`. One `acquireDirWatch` on the run's folder re-reads both
  on every change (`readProgress`), and the child's exit decides the outcome
  (`settle`). Only stdin is a pipe — a write-only sink for the pasted code.
- What the output means is `machine/internal/cli-output.ts`, pure and tested:
  the arguments per target, the manual URL (`visit: <url>`), the handed URL,
  the token, and a failure's message (Claude Code's last line, never its
  paste prompt, any credential masked).
- Run folders are `cache/claude-sign-in/<pid>-<id>` (`data-dirs`), mode 0700,
  deleted when the run ends; a start sweeps folders whose backend is gone (one
  may hold a printed token).

### Open point: `setup-token`'s output

`setup-token` prints nothing while it waits, and how it prints the token on
success has not been observed yet (it needs one real sign-in). The parser takes
the first `sk-ant-oat…` in the output; finding none fails the run with
"setup-token finished without printing a token." and files a server error
report (its output length only — never the output). Adjust
`parseSetupToken` once a real run is seen.

## Web

- **The health report's Claude Code row** (rendered by
  `conversations/runtime-sdk`): `ClaudeCodeSignInRemedy` is the row's `remedy`
  — the Sign in split button (main half: Claude subscription; chevron: the
  three methods), shown only while the computer is known signed out and no run
  is open; starting expands the row. `ClaudeCodeSignInDetail` heads the row's
  detail with the run's panel. `useClaudeCodeSignInHealth(cli)` folds the run
  into the row's verdict (`signInHealth`, tested): `attention` "Signing in…"
  (pulsing) while it runs, `critical` "Sign-in didn't finish" when it failed.
- **The Claude accounts** (`runtime-sdk`'s `claude-accounts.tsx`):
  `AddClaudeAccountSignIn` — a name, Sign in, then the same panel for the run
  it started; `onAdded(accountId)` once the account is saved (it appears in
  the list through `claude-accounts`), `onClose` when the run is cancelled,
  dismissed or replaced.
- **The panel** (`ClaudeSignInPanel`): waiting — "Finish signing in to Claude
  in your browser" (Anthropic Console for a Console sign-in), Cancel, *Open the
  page again*, and *Signing in on another device?* (when Claude Code printed
  one: the copyable page and a "Paste the code from the page" field +
  Continue); failed — Claude Code's words, Close, Try again.
- **`ClaudeSignInHost`** (`Core.Root`): only the tab whose click started a
  run (`started-here.ts`) opens its page in the browser — once, when the URL
  arrives a few hundred milliseconds after the click (a blocked popup leaves
  *Open the page again*) — and toasts its success once. It reads nothing until
  this tab has started a run.

## Rules

- The child is the bundled build, spawned by hand — the `claude-sdk/no-claude-bin-spawn`
  and `spawn-safety/no-raw-bun-spawn` exemptions (`exempt/index.ts`) are for
  `machine/internal/run.ts` alone: signing in has no Agent SDK form.
- Its environment is `claudeSessionEnv(SYSTEM_ACCOUNT_ID)` (host facts only —
  no inherited credential variable — plus `DISABLE_AUTOUPDATER=1`) and
  `BROWSER`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Signing in to Claude from the app, shown: the Claude Code row's pieces (ClaudeCodeSignInRemedy — the Sign in split button: Claude subscription / Anthropic Console / Single sign-on — ClaudeCodeSignInDetail — the run's panel: finish in your browser, Open the page again, Signing in on another device? with the copyable page and a code field, Cancel; failed: Claude Code's words, Close, Try again — and useClaudeCodeSignInHealth, 'Signing in…' while it runs), AddClaudeAccountSignIn for the Claude accounts (a name, then the same flow; the account appears once added), and, at the root, the page a run this tab started opened in the browser and its outcome toasted, once.
- Web:
  - Contributes: `Core.Root` → `ClaudeSignInHost`
  - Uses: 26 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×7
    - `infra/endpoints` ×2
    - `network/live` ×2
    - `infra/claude-cli/availability.useClaudeCodeStatus`
    - `primitives/collapsible.useCollapsibleContext`
    - `primitives/copy-to-clipboard.CopyButton`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/spacing.Stack`
    - `primitives/css/spinner.Spinner`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/link-gesture.openInBrowserTab`
    - `primitives/live-state.foldResource`
    - `primitives/loading.Loading`
    - `shell/toast.showToast`
    - `ui/icons.Icon`
  - Exports (values):
    - `AddClaudeAccountSignIn`
    - `ClaudeCodeSignInDetail`
    - `ClaudeCodeSignInRemedy`
    - `useClaudeCodeSignInHealth`
- Server:
  - Contributes: `resource.declare` "claude-sign-in.flow"
  - Resources: `claude-sign-in.flow` (push, notified)
- Machine:
  - Uses:
    - `infra/claude-cli/accounts.addClaudeAccountWithCredential`
    - `infra/claude-cli/sdk.bundledClaudeBin`
    - `infra/endpoints.implementMachine`
    - `network/live.serveValue`
  - Routes:
    - `POST /api/claude-sign-in/start` — unpredicted (server-decided)
    - `POST /api/claude-sign-in/code` — unpredicted (precondition)
    - `POST /api/claude-sign-in/cancel` — predicted
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
    - `network/live.patchValue`
  - Exports (types):
    - `ClaudeSignInFlow`
    - `ClaudeSignInMethod`
    - `ClaudeSignInTarget`
  - Exports (values):
    - `cancelClaudeSignIn`
    - `CLAUDE_SIGN_IN_METHODS`
    - `claudeSignInFlow`
    - `ClaudeSignInFlowSchema`
    - `ClaudeSignInMethodSchema`
    - `ClaudeSignInTargetSchema`
    - `startClaudeSignIn`
    - `submitClaudeSignInCode`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --primary-text`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
  - Imported by: `conversations/runtime-sdk`
- Exemptions:
  - Exempts itself from:
    - `claude-sdk/no-claude-bin-spawn` — `machine/internal/run.ts` (sanctioned)
    - `spawn-safety/no-raw-bun-spawn` — `machine/internal/run.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
