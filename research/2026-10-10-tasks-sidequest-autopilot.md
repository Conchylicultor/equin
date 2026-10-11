# Sidequest autopilot

Prototype (aspirational): `proto-1791565826-vqkm7s` — three moments (before you leave / away / back), built on the Automations prototype `proto-1791322234-nhur`. Wiki context: "Dark factory" page (`block-3d0f395a-189e-47ec-a14c-052e17a46ee7`) — this is its "First workflow".

## Context

Sidequests pile up faster than they're worked: agents file them as they notice issues, and nobody launches them. The user has leftover weekly quota at the end of the week and when away. The goal is an automation that, once switched on, works through the sidequest backlog in the background — a few agents at a time, the next starting when one finishes — and leaves, for each sidequest, a report the user reads when back: what the problem was and why we care, the mental model before → after, what changed, caveats. Uncontroversial changes push themselves; everything else stops at a built branch and asks one question.

Selection must be automatic (the user lacks context on most sidequests, so no manual ordering). A Sonnet triage pass reads each candidate first: obsolete? clear? risky? too big? value for size? — and writes a free-form context for a human.

The mockup is aspirational: this plan lands it in three phases; phase 1 is useful on its own.

## What exists (reuse, don't rebuild)

- **Automations** (`plugins/tasks/plugins/automations`): `defineAutomation` + `defineAutomationConfig` (common fields `enabled/push/model/trigger/…/prompt`, extra fields via the 3rd arg), job `automation.<id>` (singleton), `renderPrompt` + `PUSH_POLICY_TEXT` (`core/internal/template.ts`), origin side-table `tasks_ext_origin` (`server/internal/origin.ts`: `automationOfTask`, `openAutomationTaskId`), catalog `automations.catalog`, pane sections + `Automations.Section` slot, `automations.task-status` job on `tasks.statusChanged` (`server/internal/attention.ts`). Model today: **detect → file ONE task → arm it; stop while it's open.** No "launch existing tasks", no concurrency.
- **Launch**: `armTaskAutoStart` (`plugins/tasks/server/internal/arm-auto-start.ts`) writes the `tasks_ext_auto_start` marker and enqueues `tasks.maybe-launch`; `launchTaskNow(taskId, {prompt?, cause, ifAlreadyStarted})` (`plugins/conversations/server/internal/auto-start-jobs.ts`) claims the marker exactly once. The queue path always uses `buildTaskPrompt(task)` — a custom prompt only reaches the agent through an inline `launchTaskNow` call. No global concurrency cap exists.
- **Tasks**: status derived in `tasks_v` (`tasks-core/server/internal/derived.ts`); `hasBlockingDep(taskId, db)`; track side-table `tasks_ext_track` (`task-track`, row only for sidequests; `listSidequestIds(ids)`); `taskStatusChanged`, `conversationTurnCompleted` trigger events.
- **MCP** (`plugins/infra/plugins/mcp`): per-request `McpServer` built from the global registry in `handle-mcp.ts`; `McpToolContext = { conversationId }`; `Mcp.instructions` can already return `null` per conversation.
- **Background Sonnet run with an MCP result**: the summary plugin's pattern (`conversations/plugins/summary/server/internal/handle-generate.ts`): `createConversation({ model: "sonnet", kind: "system", spawnedBy, … })` + the run calls a `submit_*` tool. `submit_conversation_summary` itself is effectively unused (2 rows, last April) — out of scope here; a cleanup task.
- **Entity extensions** (`defineExtension(_tasks | _conversations, name, shape)`), **turn-summary** card pattern (`Conversation.AbovePromptInput`), **usage-limit menu** recognition (`menu-relay/plugins/usage-limit/web/internal/limit-menu.ts`, browser-only today).

## Design

### 1. Automations get a second kind: `launch` (framework change)

`AutomationSpec` becomes a union on `kind`:

- `kind: "file"` — today's `detect` → one task (existing automations, unchanged behaviour; default).
- `kind: "launch"` — `candidates(ctx): Promise<LaunchCandidate[]>` returns EXISTING task ids, best first, each with the prompt variables for it. The framework owns everything generic:
  - **Slots**: config gains `concurrency` (common field for launch-kind configs). A task occupies a slot from launch until it is **settled**: released (origin row `releasedAt` set), or its task is `done`/`dropped`/`attempted` (agent gone without a report — counts as finished, flagged). The framework exports a generic `releaseLaunchedTask(taskId)` (sets `releasedAt`, fires the owning automation); the outcome-report plugin calls it on submit — the framework never imports the report plugin (no cycle; outcome-report → automations only). A waiting-for-you conversation that has posted its report does NOT hold a slot.
  - **Pump**: the job, on each run, computes `free = concurrency − occupied`, takes the first `free` candidates, and launches each. Woken by: Start (Run now), a config change, `automations.task-status` for a task this automation launched (extend that job: besides notifying, `fire()` the owning launch automation), and an outcome report being submitted. All push-based; no polling.
  - **Origin**: the `tasks_ext_origin` row is written on launch too, with a `role: "filed" | "launched"` column, so History, the `origin` field, the bell and `automationOfTask` work unchanged. A task launched by autopilot is still the user's task — the role says the automation only started it.
  - **Catalog**: `openTaskId` (single) generalises to `runningTaskIds` + `concurrency`; the list row shows "N running".
- Dedupe ("one open task") stays `file`-kind only.

Why in the framework, not a bespoke job: the pane (Behavior/Push/Model/Prompt/History), the bell, the origin field and the config plumbing are all generic; a second automation that launches existing tasks (e.g. "work the Improvements folder") then costs a `candidates` function.

### 2. The armed launch carries its prompt (fix the primitive)

Add a nullable `autoStartPrompt` column to `tasks_ext_auto_start`; `armTaskAutoStart({ taskId, model, prompt?, cause })` stores it, and `launchTaskNow` uses `opts.prompt ?? marker.autoStartPrompt ?? buildTaskPrompt(task)`. Then ANY path that claims the marker (the queue's `tasks.maybe-launch` or an inline call) launches with the automation's prompt — there is no way to launch an automation-armed task with the bare task text. The launch kind just calls `armTaskAutoStart` with the rendered prompt; existing gates (main-only, not held/dropped, not blocked, Claude Code ready, model resolves) apply for free.

### 3. Outcome report (its own plugin: `tasks/plugins/outcome-report`)

- Side-table `tasks_ext_outcome_report` (per task; latest wins): `{ conversationId, body (markdown, free-form but prompted to cover: problem & why, before → after, what changed, caveats, decision needed), pushed (bool, derived at submit from the attempt's pushes), question?, answers?: string[], submittedAt }`.
- MCP tool `submit_outcome_report` — visible ONLY to conversations whose task has an automation origin row. Needs **`when?(ctx)` on `Mcp.tool`** (`infra/mcp/server/internal/mcp.ts` + the loop in `handle-mcp.ts`): skip registering the tool for that request when false. Cheap check: `getConversation → automationOfTask`. Hidden from `tools/list` and uncallable elsewhere. Its instructions section uses the existing `Mcp.instructions` null-return the same way.
- Submitting fires the launch automation (frees the slot) and records a bell notification when `question` is set.
- UI phase 1: a card above the prompt input (turn-summary pattern) + the row's expanded report in the automation's History. The conversation stays open (`waiting`) so it sits in the user's queue — the prompt says never `exit_clean`.
- Reusable: report-investigations agents can use it too (they already have an origin row).

### 4. Sidequest autopilot (its own plugin: `tasks/plugins/sidequest-autopilot`)

- Config `sidequest-autopilot` (`defineAutomationConfig`, kind launch): common fields + `concurrency` (default 2) + `runUntil` (`stopped` | ISO datetime; default `stopped` = runs until the user turns it off) + `triagePrompt` (phase 2).
- `candidates`: sidequest-track tasks (query `tasks_ext_track` — add a `listSidequestTasks()` server export to task-track) whose status is `new`, not held/dropped, `!hasBlockingDep`, not already launched by this automation in this window. Phase 1 order: oldest first (no triage yet); phase 2: triage's value-for-size.
- `runUntil` reached ⇒ the job turns `enabled` off (config write) and stops launching; running agents finish and report.
- Agent prompt template (default in `config/tasks/automations/sidequest-autopilot.origin.jsonc`, editable through the existing Prompt section): never ask questions; first check the task isn't obsolete (drop + report if so); stay in scope, file extras as sidequests; stop early on too-big/design-choice; `{{pushPolicy}}`; never touch migrations/auth/gateway without leaving the push to the user; end with `submit_outcome_report`, don't close the conversation. Variables: `title`, `description`, `context` (phase 2: triage's), `decision` (phase 2: the user's triage answer), `pushPolicy`.

### 5. Triage (phase 2, in the sidequest-autopilot plugin)

> **Superseded** by `research/2026-10-11-tasks-sidequest-autopilot-v2.md`: no auto-approval at all (every launch is the person's explicit approval in a launch list), a total cap, and a read-only `claude --print` instead of a system conversation.

- Side-table `tasks_ext_triage`: `{ verdict: ready | decide | split | obsolete, context (free-form markdown), question?, answers?, answer?, risk, size, value (1–5), areas (plugin paths), mainSha, triagedAt }`.
- A triage job keeps a buffer of K triaged candidates ahead of the slots (and re-triages a row whose `mainSha` is stale when it reaches the front). Each triage = a `kind: "system"` Sonnet conversation (summary pattern), read-only, prompt = `triagePrompt`, result via MCP `submit_triage` (gated with `when` to triage conversations). Cleanup on submit, not a timer. Verify system conversations don't show in the queue (`classifyQueue` has no kind filter — filter upstream if needed).
- Launch gate setting `autoApprove: clear-low | clear | never`; `obsolete: propose | drop`. `decide`/`split` rows wait for the user's one-click answer (stored as `answer`, fed to the agent as `{{decision}}`; `split` files the proposed children as sidequests).
- `areas` drives "one agent per plugin area" in `candidates`.
- Pane: an `Automations.Section` (Triage) — settings, the ready count, and the Needs your call / Queue / Looks obsolete groups with each row's free-form context and its question buttons. The second template (`triagePrompt`) needs the Prompt section to support several template fields: generalise `PromptSection` to iterate templates the spec declares (`templates: [{ field, label, variables }]`) rather than hard-coding `prompt`.

### 6. Phase 3 (aspirational parts of the mockup)

- **Usage limit**: move `isUsageLimitMenu`/`parseResetTime` to a `core/` the server can use; when an autopilot conversation shows the menu, stop launching (and, with "stop at the usage limit" off, answer Wait & continue via `answerTerminalMenu`). Never answer "Use usage credits". The quota meter needs a usage source — none exists; leave out until one does.
- **Pause while main is red**: needs a main-build-status signal (check `apps/deploy` / build ops); gate the pump on it.
- **Keep the machine awake** while enabled (a `caffeinate -w <server pid>` child, or document the limitation).
- **"While you were away"**: a queue section/badge for conversations with an unread outcome report (`queue-fields.ts` SECTION_FIELD + `use-queue-rows.ts`); Seen/Revert actions on reports.
- **Weekly window** (`runUntil` → a schedule that opens Saturday and closes at quota reset).
- **Hibernation**: a 48 h-idle waiting conversation is hibernated (resumable) — fine for reviewed-later reports; note only.

## Phases

1. **Autopilot without triage** — framework `launch` kind (§1), prompt on the marker (§2), `Mcp.tool` `when` + outcome-report plugin with its card (§3), sidequest-autopilot plugin with config/candidates/prompt (§4). Usable: switch on, it works through unblocked sidequests oldest-first, N at a time, until you switch it off or the date passes; each leaves a report in your queue.
2. **Triage** — §5.
3. **Away-mode polish** — §6.

## Critical files

- `plugins/tasks/plugins/automations/server/internal/{registry,define,origin,attention,live}.ts`, `core/internal/{config,entry,resources}.ts`, `web/components/{automation-detail,prompt-section,automation-history}.tsx`
- `plugins/tasks/plugins/auto-start/{shared/resources.ts,server/internal/{tables,mutations}.ts}`, `plugins/tasks/server/internal/arm-auto-start.ts`, `plugins/conversations/server/internal/auto-start-jobs.ts`
- `plugins/infra/plugins/mcp/server/internal/{mcp,handle-mcp}.ts` (+ `handle-mcp.test.ts`)
- `plugins/tasks/plugins/task-track/server/index.ts` (export a sidequest listing)
- New: `plugins/tasks/plugins/outcome-report/`, `plugins/tasks/plugins/sidequest-autopilot/`, `config/tasks/automations/sidequest-autopilot.origin.jsonc`
- Update `plugins/tasks/plugins/automations/CLAUDE.md` (the two kinds).

## Verification

- Unit: `when` filtering in `handle-mcp.test.ts` (hidden from list, refused on call); launch-kind slot math (occupied/settled) and candidate filtering (track, status, blocked); `launchTaskNow` prompt precedence. `./singularity test plugins/tasks/plugins/automations plugins/infra/plugins/mcp plugins/tasks/plugins/sidequest-autopilot`.
- `./singularity build`, then on the worktree deploy: file 3 trivial sidequests (one blocked by another), set concurrency 1, push `never`, Run now. Check via `query_db`: one `tasks_ext_origin` row role `launched`, the marker carried the prompt (first user turn in the transcript is the template), the blocked one isn't launched; submit the report from the agent → the next sidequest launches; the report card shows in the conversation and in History; `submit_outcome_report` absent from a normal conversation's tool list.
- Screenshot the automation pane (`screenshot.ts --path /agents/automation/sidequest-autopilot`).
- Automations run on main only: the end-to-end loop is verified after push, with concurrency 1 and push `never` first.
