# claude-cli/sign-in

Signing in to Claude from the app. The user never runs a command: the app
runs Claude Code's own sign-in (the build the Agent SDK ships,
`bundledClaudeBin()`), opens its page in the browser, and shows where it
stands. Plan: `research/2026-10-29-global-bundled-claude-code.md` (Phase 3).

## What it signs in

Only **the computer's own Claude Code login** (the system account): `auth
login` with the method the user picked (`CLAUDE_SIGN_IN_METHODS`: Claude
subscription, Anthropic Console `--console`, Single sign-on `--sso`), under
the default `CLAUDE_CONFIG_DIR`. Claude Code stores the login itself — the app
never sees a credential. On success the machine half calls
`recheckClaudeCodeNow()` (`availability`): the health row flips through the
`claude-code-status` push and armed auto-start tasks resume through
`onClaudeCodeReady`. A re-check that still is not `ready` fails the run.

There is no second target. The app once also signed in *another* plan
account (`setup-token`, under a pseudo-terminal, its printed token saved to
the secrets store); that is gone (2026-11) — Anthropic's terms say developers
may not "collect, store, or intermediate Claude.ai credentials or session
tokens". Another plan is used by signing the computer in to it here; an extra
account is an API key, pasted (`claude-cli/accounts`).

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

`idle` | `waiting { id, method, url, manualUrl }` | `done { id, method }` |
`failed { id, method, error }`, a `needsMachine` push value
served external + notified from the machine half's memory
(`machine/internal/flow-state.ts`). No polling anywhere:

- `$BROWSER` is a shim (`<run>/browser.sh`) that appends the page Claude Code
  asks to open to `<run>/browser-url`. One `acquireDirWatch` on the run's
  folder re-reads it on every change (`readProgress`), and the child's exit
  decides the outcome (`settle`).
- **`auth login`** writes plain text: its stdout and stderr are one **file
  descriptor** onto `<run>/output` (never a pipe — `infra/spawn`'s wedge),
  re-read by the same watch. Only stdin is a pipe — a write-only sink for the
  pasted code.
- What the output means is `machine/internal/cli-output.ts`, pure and tested:
  the arguments per method, the manual URL (`auth login`'s `visit: <url>`),
  the handed URL, and a failure's message (Claude Code's last line, never its
  paste prompt, any credential masked).
- Run folders are `cache/claude-sign-in/<pid>-<id>` (`data-dirs`), mode 0700,
  deleted when the run ends; a start sweeps folders whose backend is gone.

## Web

- **The health report's Claude Code row** (rendered by
  `conversations/runtime-sdk`): `ClaudeCodeSignInRemedy` is the row's `remedy`
  — the Sign in split button (main half: Claude subscription; chevron: the
  three methods), shown only while the computer is known signed out and no run
  is open; starting expands the row. `ClaudeCodeSignInDetail` heads the row's
  detail with the run's panel. `useClaudeCodeSignInHealth(cli)` folds the run
  into the row's verdict (`signInHealth`, tested): `attention` "Signing in…"
  (pulsing) while it runs, `critical` "Sign-in didn't finish" when it failed.
- **The panel** (`ClaudeSignInPanel`): waiting — "Finish signing in to Claude
  in your browser" (Anthropic Console for a Console sign-in), Cancel, *Open the
  page again*, and *Signing in on another device?* (when Claude Code shows
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

- Description: Signing in to Claude from the app, shown: the Claude Code row's pieces (ClaudeCodeSignInRemedy — the Sign in split button: Claude subscription / Anthropic Console / Single sign-on — ClaudeCodeSignInDetail — the run's panel: finish in your browser, Open the page again, Signing in on another device? with the copyable page and a code field, Cancel; failed: Claude Code's words, Close, Try again — and useClaudeCodeSignInHealth, 'Signing in…' while it runs), ClaudeCodeFix — a Claude Code block drawn with its fix inline (what is wrong, Sign in or the open run's panel, Check again), the one way a launch surface shows one — with ClaudeCodeFixButton (a Sign in button opening it, where a launch control has no room) and ClaudeCodeFixWhileBlocked (the fix only while the computer is blocked, for a past failure's record), and, at the root, the page a run this tab started opened in the browser and its outcome toasted, once.
- Web:
  - Contributes: `Core.Root` → `ClaudeSignInHost`
  - Uses: 25 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×7
    - `infra/endpoints` ×3
    - `infra/claude-cli/availability.useClaudeCodeStatus`
    - `network/live/live-state.foldResource`
    - `network/live.useLive`
    - `primitives/collapsible.useCollapsibleContext`
    - `primitives/copy-to-clipboard.CopyButton`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/spacing.Stack`
    - `primitives/css/spinner.Spinner`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/link-gesture.openInBrowserTab`
    - `primitives/overlay/popover.InlinePopover`
    - `shell/notifications.useToast`
    - `ui/icons.Icon`
  - Exports (values):
    - `ClaudeCodeFix`
    - `ClaudeCodeFixButton`
    - `ClaudeCodeFixWhileBlocked`
    - `ClaudeCodeSignInDetail`
    - `ClaudeCodeSignInRemedy`
    - `useClaudeCodeSignInHealth`
- Server:
  - Contributes: `resource.declare` "claude-sign-in.flow"
  - Resources: `claude-sign-in.flow` (push, notified)
- Machine:
  - Uses:
    - `infra/claude-cli/sdk.bundledClaudeBin`
    - `infra/endpoints.implementMachine`
    - `network/live.serveValue`
  - Routes:
    - `POST /api/claude-sign-in/start`
    - `POST /api/claude-sign-in/code`
    - `POST /api/claude-sign-in/cancel`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
  - Exports (types):
    - `ClaudeSignInFlow`
    - `ClaudeSignInMethod`
  - Exports (values):
    - `cancelClaudeSignIn`
    - `CLAUDE_SIGN_IN_METHODS`
    - `claudeSignInFlow`
    - `ClaudeSignInFlowSchema`
    - `ClaudeSignInMethodSchema`
    - `startClaudeSignIn`
    - `submitClaudeSignInCode`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --primary-text`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `apps/agent-manager/welcome`
    - `apps/home/new-app`
    - `conversations/conversation-view/jsonl-viewer/api-error`
    - `conversations/runtime-sdk`
    - `primitives/launch`
- Exemptions:
  - Exempts itself from:
    - `claude-sdk/no-claude-bin-spawn` — `machine/internal/run.ts` (sanctioned)
    - `spawn-safety/no-raw-bun-spawn` — `machine/internal/run.ts` (sanctioned)
    - `page-hosts-on-demand` — `web/index.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
