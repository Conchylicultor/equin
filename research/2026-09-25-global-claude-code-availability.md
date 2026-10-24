# Claude Code availability: the running app knows, shows, and refuses early

## Context

Clean-VM install (2026-09-18): the app deployed with no `claude` binary, and nothing told
the user it could not launch an agent.

**Already fixed today (9eb63fbcb, `research/2026-09-25-global-setup-prerequisites-v2.md`):**
`docs/setup.md` step 3 installs and signs in to Claude Code; the `mise.toml` header is
corrected; `doctor.sh` (`framework/cli/plugins/doctor`) checks *installed* + *signed in*
(`claude auth status --json`) at `mise install`, `./equin start` and deploying `build`.

**What is still missing — the running app.** Every remaining gap is at runtime:

1. (Not a gap: release bundles strip the agent manager on purpose, and the roadmap page
   "[Planned] Installable by others" puts a packaged app out of scope — the target user
   clones the source, so the doctor covers the install.)
2. **Things change after install.** Sign-out, an expired token or an uninstall happen
   between builds; the doctor only runs at build time.
3. **`CLAUDE` is a module-eval constant that degrades to the bare string `"claude"`**
   (`infra/paths/server/internal/bins.ts:17`). A missing binary is spelled as if it were
   present; installing Claude Code after the backend booted is not seen until restart.
4. **A missing/signed-out CLI fails late and unclassified.** `tmux-runtime.ts` runs
   `claude …` inside a tmux pane: tmux succeeds, the pane shell prints `command not found`
   and dies. `spawn-job.ts` only knows generic failures ("Conversation spawn failed", 5
   retries). A signed-out CLI opens a pane that sits at a login prompt. `runClaudePrint`
   (titles, extraction) fails into generic `ClaudeCliError` reports.

Roadmap fit: this is the groundwork for step 3 ("First run: a welcome screen that checks
Claude Code") of "[Planned] Installable by others". The welcome screen itself is not built
here; it will read the same `useClaudeCodeStatus()`.

Outcome: the app has one live answer to "can I run an agent?" — `ready` / `signed-out` /
`missing` — shows it in the health report, and refuses a launch up front with the fix,
instead of a dead pane.

## Design

### 1. Resolution becomes a result, not a string (rung 1)

`infra/paths/server/internal/bins.ts`: replace the `CLAUDE` constant with
`resolveClaudeBin(): { kind: "found"; path } | { kind: "missing"; searched: string[] }`,
re-run on every call (one `Bun.which` + three `existsSync` — microseconds), so an install
after boot is seen. The bare-`"claude"` fallback disappears: "missing" can no longer be
spelled as a path. `doctor.test.ts` already keeps doctor.sh's candidate list in step with
this file; point it at the exported candidate list.

Exec sites take the path from a single throwing accessor `requireClaudeBin()` →
`ClaudeCodeMissingError` (named, carries `searched`):
- `conversations/runtime-tmux/.../tmux-runtime.ts` (agent sessions)
- `infra/claude-cli/.../run-claude-print.ts` (one-shot calls)

### 2. `infra/claude-cli/plugins/availability` — the one status authority (new sub-plugin)

Lives under `claude-cli` (the plugin that already owns "we shell out to the user's Claude
login"). Import direction: runtime-tmux and conversations import it; it imports only
paths/spawn/live-state/file-watcher.

**core** — the state as data:
```ts
type ClaudeCodeStatus =
  | { kind: "ready"; version: string; account: { email?: string; authMethod: string } }
  | { kind: "signed-out"; version: string }
  | { kind: "missing"; searched: string[] }
  | { kind: "unreadable"; error: string };   // probe crashed / timed out / bad JSON
```
plus the fix text per arm (`curl -fsSL https://claude.ai/install.sh | bash`,
`claude auth login`) — one spelling shared by server errors, the health row and the
launch UI (doctor.sh keeps its own sh copy; a test asserts they match).

**server**
- `probeClaudeCode()`: `resolveClaudeBin()`; then `claude --version` and
  `claude auth status --json` via `spawnCaptured` with a timeout, the JSON **zod-parsed**
  (`loggedIn`, `authMethod`, `email`) — not string-matched. Verified shape on this
  machine (Claude Code 2.1.282): `{"loggedIn":true,"authMethod":"claude.ai",…,"email":…}`.
  Implementation step 1: confirm the signed-out output/exit code before relying on it.
- `claudeCodeStatusResource` — a small scalar push live-state resource (schema-bounded,
  so the membership-bounding rule does not apply). Probed lazily on first read, cached.
- **Freshness, no polling** — re-probe on:
  - the launch gate, when the last answer is not a `ready` younger than 5 min;
  - `POST /api/claude-code/recheck` (the "Check again" button);
  - the window regaining focus while the status is blocked (`RecheckOnReturn`):
    installing and signing in happen in a terminal;
  - evidence: `requireClaudeBin()` finding nothing, `claude --print` exiting non-zero.
  - *Implemented without a file watcher:* `~/.claude.json` is rewritten constantly by
    every running agent (a re-probe storm), and the login itself lives in the Keychain.
- `assertClaudeCodeReady()` → throws `ClaudeCodeUnavailableError { status }` unless
  `ready`; reads the cached status, re-probing when the cache says not-ready (so a user who
  just logged in in a terminal is never refused by a stale "signed-out").

**web**
- `useClaudeCodeStatus()` over the resource (pending is its own state, never "missing").
- `HealthReport.Row({ kind: "status", id: "claude-code", title: "Claude Code", order: 5 })`:
  `ready` → ok ("Signed in as …, v2.1.282"); `signed-out` / `missing` → **critical** (the
  app's core job is broken), with the fix command (CopyButton) and "Check again";
  `unreadable` → unknown with the error.

### 3. Refuse the launch up front, with the fix

- `conversations/server/internal/lifecycle.ts` `prepareConversation` (phase 1, reads only)
  and `resumeConversation` call `assertClaudeCodeReady()` **before** any row/job is
  written. The launch endpoints map `ClaudeCodeUnavailableError` to a typed error body, so
  every launch surface (LaunchControl, LaunchAgentForm, task Launch, mod+N) shows the one
  message + fix via the existing endpoint-error path — no per-surface wiring.
- `LaunchControl` / `LaunchAgentForm` additionally read `useClaudeCodeStatus()`: when
  `signed-out`/`missing`, the Launch button is disabled with a tooltip carrying the fix
  (the refusal above is the authority; this just avoids the round-trip).
- **Auto-start** (`auto-start-jobs.ts launchArmedTask`): a not-ready Claude Code must not
  burn retries or dead-letter the task — the job leaves the task armed and returns; the
  status transition to `ready` (resource change) re-kicks armed tasks. (Implementation to
  confirm the existing "blocked → retry when unblocked" hook auto-start already has, and
  reuse it.)
- `spawn-job.ts`: a `ClaudeCodeMissingError` from `create` is classified — notification
  titled "Claude Code is not installed" with the fix, and no pointless graphile retries
  (fail the job permanently).

### 4. Docs

- `infra/claude-cli/CLAUDE.md` + the new sub-plugin's CLAUDE.md: the status model, the
  freshness triggers, "exec only through `requireClaudeBin()`".
- `docs/setup.md`: one line — the app's health report shows Claude Code's state.
- `framework/cli/plugins/doctor/CLAUDE.md`: note the runtime twin.

## Critical files

- `plugins/infra/plugins/paths/server/internal/bins.ts`, `.../paths/server/index.ts`
- `plugins/infra/plugins/claude-cli/plugins/availability/{core,server,web}/` (new)
- `plugins/infra/plugins/claude-cli/server/internal/run-claude-print.ts`
- `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`
- `plugins/conversations/server/internal/{lifecycle,spawn-job,auto-start-jobs}.ts`
- `plugins/primitives/plugins/launch/web/components/launch-control.tsx` (+ the form)
- `plugins/framework/plugins/cli/plugins/doctor/cli/doctor.test.ts` (candidate-list parity)

## Verification

- Unit (`./equin test plugins/infra/plugins/claude-cli`): `probeClaudeCode` against
  a stub `claude` on a temp PATH (via `SINGULARITY_CLAUDE_BIN`) — logged in, logged out,
  missing, garbage JSON, timeout → the four arms.
- jsdom: health row renders each arm; LaunchControl disabled on signed-out.
- Live, on this worktree's deploy:
  - `SINGULARITY_CLAUDE_BIN=/nonexistent` for the backend → health dot critical with the
    install line; Launch refused with the message, no conversation/attempt row written
    (`query_db`).
  - `SINGULARITY_CLAUDE_BIN=<stub reporting loggedIn:false>` → row shows signed-out;
    swap the stub to logged-in + Check again → ready, armed auto-start task launches.
    (Never `claude auth logout` the real account to test this.)
  - screenshot.ts of the health popover in each state.
