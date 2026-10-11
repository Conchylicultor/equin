# Sidequest autopilot v2 — triage, explicit approval, total cap

Supersedes §5 (Triage) of `research/2026-10-10-tasks-sidequest-autopilot.md`; phase 1 (§1–§4) is shipped and is the base.
Prototype: `proto-1791565826-vqkm7s` (consistent with Automations `proto-1791322234-nhur`).

## Context

Phase 1 launches every ready sidequest oldest-first. On main today 31 sidequests are `new` and the 5 oldest are all deep live-resource concurrency bugs — the worst thing to hand an unattended agent first. The user wants to see and control the batch before anything runs, without ordering 31 tasks they lack context on.

Rules from the user (load-bearing):

- **Nothing launches unless the user explicitly approved that task.** Approval is per task, made in the review list. Nothing is auto-approved, whatever triage says. Triage may only **pre-select** (pre-tick) rows in the list.
- The autopilot launches only from the approved set, best first, `concurrency` at a time, up to a **total cap**.
- Sonnet may triage every sidequest in the background without asking: once per task, cached, tagged **stale** after a while (not re-run on its own).
- The prototype's "Launch without asking" setting goes away.

## Design

### 1. Approval is a framework guarantee (automations, launch kind)

Make "unapproved never launches" have no spelling, for every launch automation, not just this one:

- New extension `tasks_ext_launch_decision` (`defineExtension(_tasks, "launch_decision", …)` in `automations/server/internal/tables.ts`, shape in `core/internal/resources.ts`): `{ automationId, decision: "approved" | "excluded", decidedAt }`. Written ONLY by an HTTP endpoint the user's click hits (`decideLaunch({automationId, taskIds[], decision | null})`, null clears). No server code path writes `approved`.
- `runLaunch` (`define.ts`): after `spec.candidates()`, intersect with `approvedTaskIds(spec.id)` **before** `selectLaunches`. The spec cannot bypass it — candidates only decide order and variables. A task's approval stays until it is launched (the origin row then excludes it anyway) or cleared. An approval for a task that is no longer `new` is simply never a candidate.
- `slots.ts`: `selectLaunches(candidates, taken, approved, free)` — pure, unit-tested.

### 2. Total cap = "launch N, then stop" (framework)

- `launchFields` gains `maxLaunches` (`intField`, min 1, max 50, default 5 for the autopilot).
- **Launch window**: new tiny table `automation_launch_windows (automationId pk, startedAt)` — written by `watch.ts` when `enabled` flips false→true (and at boot if enabled with no row). `launchedInWindow = count(origin rows role launched, automationId, filedAt ≥ startedAt)` (index `automation_filed` already covers it).
- Pump: `free = min(concurrency − occupied, maxLaunches − launchedInWindow)`. When `launchedInWindow ≥ maxLaunches` and nothing is pending, the automation writes `enabled: false` (`setConfig` + `systemOrigin`, same as `runUntil`). Running agents finish and report. Turning it back on opens a new window.
- Catalog launch entry gains `approvedCount`, `maxLaunches`, `launchedInWindow`; BehaviorSection shows "3 of 5 launched · 2 running".
- Turning on with 0 approved is allowed but says so ("Nothing approved — it will launch nothing").

### 3. Triage (sidequest-autopilot)

**Runner — read-only by construction.** Extend `runClaudePrint` (`infra/claude-cli/server/internal/run-claude-print.ts`) with an optional `readOnlyRepo: { cwd }`: tools `Read, Grep, Glob` plus Bash limited to `git log`/`git show`/`git grep` (allowedTools patterns, everything else denied non-interactively), `cwd` = the main checkout, JSON output. No Edit/Write exists for the model, so read-only is structural, not a prompt promise; no worktree, no tmux pane, no conversation to clean up; every call lands in `claude_cli_calls` for debugging. (Exact CLI flags verified at implementation; if a flag set can't enforce it, STOP and report rather than fall back to prompt-only.)

**Storage**: `tasks_ext_sidequest_triage` (per task, latest wins): `verdict: ready | decide | split | obsolete`, `context` (free-form markdown for a human — problem, why it matters, what fixing it involves), `question?`, `answers[]`, `answer?` (the user's click), `split[]?` (`{title, description}`), `risk: low | medium | high`, `size` (rough minutes), `value` 1–5, `areas[]`, `mainSha`, `taskUpdatedAt`, `triagedAt`, `model`.

**Staleness** (derived, never stored): stale when `now − triagedAt > triageStaleDays` (config, default 7) or the task was edited after `taskUpdatedAt`. Stale rows get a **Stale** tag and a Re-triage button; nothing re-runs on its own. Approval of a stale row stands (it's the user's decision) — the tag is shown next to it.

**When it runs** (main only, push-based): job `sidequest-autopilot.triage` (`dedup: {key: taskId}`, `serial: true` — one Sonnet at a time, bounded host cost), enqueued when a sidequest becomes `new` with no triage row (extend `ready-job.ts`), by a boot backfill over `listSidequestTasks({statuses:["new"]})`, and by Re-triage. Independent of `enabled`: triage prepares the list before the user turns anything on. Config `triage: boolean` (default on) to stop the spend.

**Prompt**: `triagePrompt` config field (default in the plugin, editable). Generalise `PromptSection` to iterate the templates a spec declares (`templates: [{field, label, variables}]`) instead of hard-coding `prompt`. Output is a zod-parsed JSON object; a parse failure throws (job retries once, then a loud failed job).

**Feeds the agent**: new prompt variables `context` (triage's) and `decision` (the user's answer, or "none"); candidates are ordered by triage `value / size` (untriaged last, oldest first); `areas` drives one-agent-per-area (skip a candidate whose area overlaps a running one).

### 4. Review list (the pane)

An `Automations.Section` "Launch list" in sidequest-autopilot, a **DataView** (`views={["list"]}`, grouped) over a live collection `sidequest-autopilot.review` = every `new` sidequest ⨝ triage ⨝ launch decision (served from a derived view; bounded `limit`/`maxLimit`). Groups:

1. **Approved** — ranked in launch order, each with Remove; header: "5 approved · launches up to 5, 2 at a time".
2. **Proposed** — triage's suggestions, checkbox **pre-ticked** for `ready` + low/medium risk; one **Approve selected (k)** button commits. Pre-ticked is UI state only — nothing is stored until the click.
3. **Needs your call** — `decide`/`split`: the question with one-click answers (stores `answer`; `split` files the children as sidequests); answering pre-ticks, does not approve.
4. **Looks obsolete** — evidence + Drop task (the user's drop) / Keep.
5. **Triaging…** — not triaged yet (count + queue position).
6. **Excluded** — collapsed; Restore.

Each row expands to triage's context (markdown), risk/size/value, Stale tag, Re-triage.

### 5. Prototype (`proto-1791565826-vqkm7s`)

- **Before**: Triage card loses "Launch without asking"; becomes the Launch list above (Approved / Proposed with pre-ticks + Approve selected / Needs your call / Looks obsolete / Triaging / Excluded), Stale tag on one row. Agents card gains **In total** stepper ("launch at most N, then switch off") next to At once. Header button reads "Start — 5 approved, 2 at a time" (disabled-looking hint at 0 approved). Behavior's Off/Propose/Auto seg → **Off / Triage only / Launch approved** (code: `triage` toggle + `enabled`). The Launch list sits right under the stats; the Triage card keeps only Stale after + Triage model.
- **Away**: "3 of 5 launched" in Running now; Up next = the remaining approved only.
- **Back**: unchanged, plus "Cap reached — switched itself off" in the activity line.
- Keep Automations-prototype vocabulary (cards, `.setting` rows, Seg, History).

## Phases / order

1. Prototype update (no code).
2. Framework: decision table + endpoint + pump filter, `maxLaunches` + window + auto-off, catalog fields, BehaviorSection; tests (`slots.test.ts`: unapproved never selected, cap math).
3. `runClaudePrint` read-only-repo mode (+ test that the arg list has no write tools).
4. Triage table, job, prompt/config, staleness, multi-template PromptSection, review collection + Launch list section, `context`/`decision` variables, value ordering, area rule.
5. Docs: `automations/CLAUDE.md` (approval + cap are framework guarantees), `sidequest-autopilot/CLAUDE.md`, mark §5 of the v1 doc superseded.

## Critical files

- `plugins/tasks/plugins/automations/server/internal/{define,slots,origin,tables,watch,live}.ts`, `core/internal/{config,resources,entry,routes}.ts`, `web/components/{behavior-section,prompt-section}.tsx`
- `plugins/infra/plugins/claude-cli/server/internal/run-claude-print.ts`
- `plugins/tasks/plugins/sidequest-autopilot/{shared/config.ts, server/internal/{automation,candidates,ready-job}.ts}` + new `server/internal/{triage-job,triage-table,review}.ts`, `web/components/launch-list-section.tsx`
- `plugins/tasks/plugins/task-track/server` (`listSidequestTasks` reused)
- `~/.singularity/apps/prototypes/proto-1791565826-vqkm7s/index.html`

## Verification

- `./singularity test plugins/tasks/plugins/automations plugins/tasks/plugins/sidequest-autopilot plugins/infra/plugins/claude-cli`.
- `./singularity build`; in the worktree: run one triage manually (Run now on the triage job for one task) → row in `tasks_ext_sidequest_triage`, call in `claude_cli_calls`, `git status` of main clean afterwards.
- With enabled on and nothing approved: Run now → `query_db` shows no new origin row. Approve 2, cap 1, concurrency 2 → exactly one launch, then `enabled` flips false. Screenshot the Launch list (`screenshot.ts --path /agents/automation/sidequest-autopilot`).
- Launching runs on main only: the end-to-end loop is checked after push with cap 1, push `never`.
