# Automations on watchers — Migrate step (Autonomous tasks, step 5)

Track: wiki page `block-28d79bb7-…` · Design: `block-9fe10dae-…` §7 and "Every workflow as a definition" · Previous steps: `research/2026-10-28-tasks-watcher-report-building-block.md`, `research/2026-10-29-tasks-autonomous-run-mode.md`.

## Context

The track's third exit criterion: the sidequest autopilot runs on the same Mandate / Watcher / Report blocks, and the blocks hold no workflow code. The Watcher step already did most of §7: launched tasks carry the automation's mandate, and the `automations.slot` code watcher frees a slot on the task's own report (`outcome-report` names no automation). Three things remain:

1. **A slot still frees through a status job, not the watcher.** `automations.task-status` (`server/internal/attention.ts`) calls `wake()` when a launched task enters `SLOT_SETTLED_STATUSES` (`done`, `dropped`, `attempted`, `held`). The watcher hears only `settled` (done / dropped) — no fact says "its agent went away without landing" or "a person held it".
2. **A file-kind automation sits idle after its task closes.** It files nothing while its task is open; when that task settles, remaining work (uninvestigated reports) waits for the next event or schedule.
3. **The watcher is not part of an automation's definition.** `mandate` is a spec field; the slot watcher is wired by hand in `runLaunch`, and nothing watches a filed task.

## Facts the design rests on

- Watch sources are contributed by the plugin owning the fact (`tasks/machine/internal/watch-sources.ts`: `created`, `started`, `settled` from `taskStatusChanged` with `isSettled`). Events go to the nearest live watch above the task; code watchers get a batch through `WatchHandler.onEvents(batch, { watch, tx })`, inside `watch.deliver` (main-only).
- `attempted` = the task has an attempt, no live conversation, nothing landed, not held/dropped (`tasks-core/server/internal/derived.ts`). Hibernation does not reach it (a column, not a status); a closed or `gone` conversation does.
- `wake()` (registry) enqueues the automation's singleton job now, whatever its trigger; main-only, no-op while off. The pump recomputes occupied slots from statuses (`occupiedSlotTaskIds`), so a wake is only a nudge — releasing (`releasedAt`) is reserved for the report, and `rings` keys the "Stopped before finishing" bell on `releasedAt === null`.
- Main has no launched task holding a slot (`tasks_ext_origin`: 7 launched, all released) and Report investigations has never filed: no transition for tasks launched/filed before this change.

## 1. Two new task facts — `tasks` watch sources

In `tasks/machine/internal/watch-sources.ts`, beside `settled`, on the same `taskStatusChanged`:

| Kind | When | Summary |
|---|---|---|
| `stopped` | enters `attempted` | `its agent ended without landing (<prev> → attempted)` |
| `held` | enters `held` | `held by a person (<prev> → held)` |

General facts, useful to any watcher (a supervisor learns a worker crashed or was held by the user), not automation-specific. Unit test beside the existing source tests.

## 2. The slot watcher wakes on every slot-freeing fact (`automations/server/internal/slot-watch.ts`)

`automations.slot.onEvents` — for events on the watched task itself:
- `reported` / `asking` → `releaseLaunchedTask` + `endWatch` (unchanged);
- `settled` / `stopped` / `held` → `registeredAutomation(watch.key)?.wake()` only — no release (a held or attempted task can resume and take its slot back, as today), watch kept.

`automations.task-status` drops its `wake()` branch (and `SETTLES_SLOT`); it keeps the bell and the catalog push. Its description and the plugin docs follow.

## 3. `watch` in the automation definition; `refire` for file kind

- `FileAutomationSpec.watch: "refire" | null` — **required**, beside `mandate`, so every file automation states what watches its filed task. `"refire"`: `runFiling` watches the filed task with code handler `automations.refire` (key = automation id); on the task's own `settled` it `wake()`s the automation (it detects again at once) and ends the watch. `null`: nothing watches it; the next scheduled or fired run looks again.
- Launch kind: no field — the slot watcher is what a launch-kind automation *is* (one legal value is no choice); documented on the spec.
- Choices: Report investigations `"refire"` (the next batch of reports goes out as soon as one settles); Dependency upgrades and Upstream merges `null` (a dropped task would be re-filed at once with the same content — a loop).
- New file `server/internal/refire-watch.ts` (handler + `watchFiledTask`), contributed in `server/index.ts` like `slotWatchHandler`.

## Files

- `plugins/tasks/machine/internal/watch-sources.ts` (+ test)
- `plugins/tasks/plugins/automations/server/internal/{slot-watch.ts, refire-watch.ts (new), attention.ts, define.ts, registry.ts}`, `server/index.ts`, `CLAUDE.md`
- `plugins/tasks/plugins/reports-investigation/server/internal/automation.ts`, `plugins/infra/plugins/deps/plugins/updates/server/internal/detect-job.ts`, `plugins/upstream/server/internal/merge-automation.ts` — `watch:`
- `plugins/tasks/plugins/orchestration/plugins/watch/CLAUDE.md` — the kinds list, if it enumerates them

## Verification

- `./equin test plugins/tasks/plugins/automations plugins/tasks/machine plugins/tasks/plugins/orchestration/plugins/watch`: source emits `stopped` / `held` once per transition; slot handler wakes without releasing on `settled`/`stopped`/`held`, releases on `reported`; refire handler wakes + ends on `settled`, ignores other tasks' events (fake registry wake).
- `./equin build` (checks: boundaries, cycles, plugins-doc-in-sync).
- Delivery is main-only, so the live check is after push: `query_db` on main for an `automations.refire` / `automations.slot` watch and its inbox rows `delivered_in_turn`.

## Track page

Migrate done; exit criterion 3 met. Note the compaction/event-delivery race seen while planning Dogfood (both triggered by the same busy→idle transition). No next task filed (user decision).
