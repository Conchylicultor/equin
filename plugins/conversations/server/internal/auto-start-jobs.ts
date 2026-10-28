import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { db } from "@plugins/database/server";
import {
  getConversation,
  getTask,
  hasBlockingDep,
  listAttemptsForTask,
  withTaskStatusBatch,
  type DbExecutor,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  ConversationStatusSchema,
  TaskStatusSchema,
  type Conversation,
} from "@plugins/tasks/plugins/tasks-core/core";
import {
  claimAutoStart,
  getTaskAutoStart,
  listArmedTaskIds,
} from "@plugins/tasks/plugins/auto-start/server";
import {
  commitConversation,
  finishConversation,
  prepareConversation,
  type PreparedConversation,
} from "./lifecycle";
import { checkClaudeCode } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { resolveModel } from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { reportAutoStartModelUnavailable } from "./auto-start-model-report";
import { resolveLaunchPrompt } from "./launch-prompt";
import {
  hostFreeLaunchSlots,
  takeHostLaunchSlot,
  type LaunchCap,
} from "./launch-cap";
import { releasedLaunchSlot, takeLaunchable } from "./launch-slots";

// The transactional heart of an auto-launch: claim the marker and commit the
// launch on ONE transaction. Returns whether this call launched.
//
// THE RULE: the marker and the launch commit together. A throw, a crash or a
// killed connection anywhere in here rolls the whole thing back — the marker is
// still there, and there is no attempt, no conversation and no fork/spawn job —
// so the job's own retry, or the boot reconcile, launches the task again.
// Nothing is ever left stranded with its marker consumed and no launch.
//
// And never twice: the claim is a `DELETE … RETURNING` on the marker row, which
// row-locks it. A concurrent runner's claim blocks on that lock until this
// transaction ends, then finds the row gone (we committed: it returns false) or
// claims it itself (we rolled back). Exactly one launch commits.
//
// `tx` must be a status batch's executor (`withTaskStatusBatch` /
// `runStatusBatchOn`) — the launch's status-changing writes assert it.
//
// `ifAlreadyStarted` says what an existing attempt on the task means, and the
// caller must say it because the two callers mean opposite things. For the
// queue (`skip`) an attempt is a manual start that raced in — the task has its
// launch, starting it again would double it. For an explicit user launch
// (`launch`) the user is asking for ANOTHER run of a task that already has one
// (a second "Fix this crash" on the same report reuses the report's task), so
// an attempt is no reason to refuse. The claim stays the exactly-once gate in
// both modes: it is what stops two runners launching one ARM.
export type IfAlreadyStarted = "skip" | "launch";

export async function launchArmedTask(
  tx: DbExecutor,
  taskId: string,
  prepared: PreparedConversation,
  opts: { ifAlreadyStarted: IfAlreadyStarted },
): Promise<boolean> {
  // Backstop for a launch that stalls between statements (the 2026-09-15
  // incident hung mid-launch for 2.5 hours): Postgres kills an idle-in-
  // transaction session after 30s, the transaction rolls back, and the marker
  // comes back on its own — no restart needed. The deadline audit still files
  // the hang as a job-deadline report, so it stays visible.
  await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '30s'`);

  // Another runner claimed it (and committed), or it was cancelled.
  if (!(await claimAutoStart(taskId, tx))) return false;

  // Queue only: a manual start raced in before our claim. Returning commits
  // the consumed marker, as before: the task already has its launch, just not
  // ours. Only a `retained` attempt (the user has not finished with it) counts:
  // a closed attempt is a past run, and re-arming a task whose runs are all
  // closed asks for another one — skipping it would silently eat the marker.
  if (
    opts.ifAlreadyStarted === "skip" &&
    (await listAttemptsForTask(taskId, tx)).some((a) => a.retained)
  ) {
    return false;
  }

  await commitConversation(tx, prepared);
  return true;
}

export type LaunchTaskNowResult =
  | { started: true; conversation: Conversation }
  // `not-armed` is a legitimate outcome, not a failure: the task carries no
  // auto-start marker (the user picked Off, or it was cancelled or already
  // launched). `claimed-elsewhere`: another runner claimed the marker first, or
  // (`ifAlreadyStarted: "skip"` only) the task already had an attempt — either
  // way it has its launch, not ours. `at-capacity` (`cap: "host"` only): the
  // host already runs `agent-launch.maxConcurrent` busy agents — nothing was
  // claimed, the task stays armed, and a freed slot wakes it
  // (`launchNextArmedJob`). A normal wait, not a failure.
  | {
      started: false;
      reason: "not-armed" | "claimed-elsewhere" | "at-capacity";
    };

// Start an armed task NOW: read the model off its marker, prepare, then claim
// the marker and commit the launch on one transaction (`launchArmedTask`). THE
// launch path for an armed task — the auto-start queue calls it once the task's
// gates pass, and an inline "file it and start it" caller calls it directly
// after writing the marker itself. Either way the claim is the exactly-once
// gate, so the two can never both launch one task.
//
// The prompt is the caller's `prompt`, else the one stored on the marker by
// whoever armed it (an automation's filled template), else the task's own
// (`buildTaskPrompt`) — `resolveLaunchPrompt`. So a task an automation armed
// launches with the automation's prompt whichever path claims it.
//
// The caller owns the policy gates (main-only, dropped / held, blocking deps):
// the queue must wait on them, while an inline launch the user asked for has
// nothing to wait for. Likewise `ifAlreadyStarted` (see `launchArmedTask`):
// required, because the queue and a user launch mean opposite things by it.
// And `cap` (see `LaunchCap`): required for the same reason — the queue waits
// under the host-wide cap, a launch a human asked for never does.
export async function launchTaskNow(
  taskId: string,
  opts: {
    prompt?: string;
    cause: string;
    ifAlreadyStarted: IfAlreadyStarted;
    cap: LaunchCap;
    /** The launcher shows the conversation itself (see `CreateConversationOpts`). */
    shownByLauncher?: boolean;
  },
): Promise<LaunchTaskNowResult> {
  const ext = await getTaskAutoStart(taskId);
  if (!ext) return { started: false, reason: "not-armed" };

  const prompt = await resolveLaunchPrompt({
    explicit: opts.prompt,
    armed: ext.autoStartPrompt,
    readTask: async () => {
      const task = await getTask(taskId);
      if (!task) throw new Error(`launchTaskNow: task ${taskId} not found`);
      return task;
    },
  });

  // Reads first, outside any transaction: nothing slow runs while the
  // marker's row lock is held. A duplicate runner prepares too and then
  // loses the claim — it has written nothing, so that costs nothing.
  const prepared = await prepareConversation({
    taskId,
    model: ext.autoStartModel,
    prompt,
    spawnedBy: opts.cause,
    shownByLauncher: opts.shownByLauncher,
  });

  // The marker and the launch commit together (see `launchArmedTask`). A
  // throw rolls back with the task still armed; under the queue graphile
  // retries, and if every attempt fails the row dead-letters (reported by queue
  // health) and the next boot's reconcile tries again.
  //
  // Under `cap: "host"` the slot check runs FIRST on the same transaction,
  // before the claim: over the cap nothing is claimed and the task stays
  // armed. The cap lock it takes is held until this transaction commits its
  // `starting` row, so the next capped runner counts it.
  const outcome = await withTaskStatusBatch(
    async (tx): Promise<"launched" | "claimed-elsewhere" | "at-capacity"> => {
      if (opts.cap === "host" && !(await takeHostLaunchSlot(tx))) {
        return "at-capacity";
      }
      return (await launchArmedTask(tx, taskId, prepared, {
        ifAlreadyStarted: opts.ifAlreadyStarted,
      }))
        ? "launched"
        : "claimed-elsewhere";
    },
  );
  if (outcome !== "launched") return { started: false, reason: outcome };
  await finishConversation(prepared);

  // `launchArmedTask` answers only whether THIS call launched; the committed
  // row is the conversation. It was written on the transaction that just
  // committed, so a miss here is a broken invariant, not an outcome.
  const conversation = await getConversation(prepared.conversationId);
  if (!conversation) {
    throw new Error(
      `launchTaskNow: conversation ${prepared.conversationId} for task ${taskId} committed but not found`,
    );
  }
  return { started: true, conversation };
}

// Job that launches a queued task once all its dependencies are non-blocking.
// Invoked by maybeLaunchOnStatusJob (static trigger on taskStatusChanged), by
// armTaskAutoStart when a task is armed, and by the boot reconcile warm-up.
//
// Concurrency: triggers can fire concurrently (multiple deps flipping at
// once, or retried jobs). `launchArmedTask` claims the marker and launches in
// one transaction, so exactly one runner commits a launch; all others see the
// marker already cleared and exit.
//
// Dedup on taskId: since the status event became closure-correct, one settle
// on a task with many dependents can wake this job for the same task several
// times over, and the boot reconcile enqueues it for every armed task at once.
// Collapsing repeat wake-ups for ONE task onto one graphile row is safe
// precisely because claimAutoStart is the exactly-once gate — the collapsed
// row does the same single check the N rows would have done.
export const maybeLaunchTaskJob = defineJob({
  name: "tasks.maybe-launch",
  description:
    "Launches an agent for an armed task once it is unblocked, making sure exactly one launch happens per task.",
  // instant: indexed reads, then one transaction of indexed writes that
  // ENQUEUES `database.fork` + `conversations.spawn` (no attemptId ⇒ never the
  // synchronous reuse branch), so the agent launch itself is those jobs' hold,
  // not this one's.
  hold: "instant",
  input: z.object({
    taskId: z.string(),
    cause: z.string().default("dep-resolved"),
  }),
  event: z.never(),
  dedup: { key: ({ taskId }) => taskId },
  run: async ({ input: { taskId, cause } }) => {
    // Main-only: a forked sub-worktree DB inherits the autoStart marker and
    // taskStatusChanged triggers from main at fork time, so the same job
    // would fire independently in every worktree's worker — each calling
    // createConversation against its own DB and producing a parallel agent
    // process. CAS protects within a single DB, not across forks.
    if (!isMain()) return;
    const t = await getTask(taskId);
    if (!t) {
      console.warn(
        `[tasks.maybe-launch] task ${taskId} not found; trigger fired but no launch`,
      );
      return;
    }
    // dropTaskTree drops a whole subtree then emits taskStatusChanged for each
    // node — the dependents (also dropped) would pass hasBlockingDep because
    // dropped deps are non-blocking. Bail if the task itself is dropped/held.
    if (t.droppedAt || t.heldAt) return;
    const ext = await getTaskAutoStart(taskId);
    if (!ext) {
      console.warn(
        `[tasks.maybe-launch] task ${taskId} has no auto_start row; trigger fired but no launch (already launched, cancelled, or never armed)`,
      );
      return;
    }
    // Some other dep is still blocking; another trigger will fire later.
    if (await hasBlockingDep(taskId, db)) return;
    // Claude Code missing or signed out: leave the task armed rather than
    // throw (graphile would retry into a dead letter). When Claude Code turns
    // ready, `onClaudeCodeReady` re-runs the armed-task reconcile, which wakes
    // this job again.
    const claude = await checkClaudeCode();
    if (claude.kind !== "ready") {
      console.warn(
        `[tasks.maybe-launch] task ${taskId} stays armed: Claude Code is ${claude.kind}`,
      );
      return;
    }

    // The armed model can no longer run (a pinned version retired since it
    // was armed). Launching would throw at spawn and graphile would retry it
    // into a dead letter nobody sees on the task — and substituting another
    // model is never an option. Say so on the task (its report, and the
    // queued chip reads the same catalog) and leave it armed: re-picking a
    // model re-arms it, which wakes this job again.
    const catalog = getModelCatalog();
    const resolution = resolveModel(ext.autoStartModel, catalog);
    if (!resolution.ok) {
      await reportAutoStartModelUnavailable(taskId, resolution, catalog);
      return;
    }

    // At the host-wide cap: a normal wait, not a failure — the task stays
    // armed and `launchNextArmedJob` wakes it when a busy agent finishes. An
    // unlocked pre-check so a saturated host does not prepare a launch per
    // wake-up; the locked check inside `launchTaskNow` is the authority.
    if ((await hostFreeLaunchSlots(db)) === 0) return;

    // `launchTaskNow` reads the marker again for its model and its prompt:
    // one indexed read, and it keeps `not-armed` launchTaskNow's own answer
    // rather than an assumption about its caller. No `prompt` here: the
    // marker's (an automation's) or else the task's own is the right one. A
    // lost claim is the concurrent-runner case this job's header describes —
    // nothing to do. `skip`: an attempt here is a manual start that beat the
    // queue, so the task already has its launch. `cap: "host"`: the queue
    // starts agents on its own, so it waits under the host-wide cap; over it
    // the task stays armed and `launchNextArmedJob` wakes it when a slot frees.
    await launchTaskNow(taskId, {
      cause,
      ifAlreadyStarted: "skip",
      cap: "host",
    });
  },
});

// Static trigger target: fires on every taskStatusChanged and re-checks the
// auto-start eligibility of the task whose status changed. That is the whole
// rule now — there is no fan-out to dependents any more.
//
// Why one task is enough. `tasks.statusChanged` used to be emitted only for the
// task ids a call site remembered to name, so it fired for the endpoint of an
// edge write and never for the downstream tasks whose derived status that write
// had just changed. It is now emitted for `{T} ∪ transitiveDependents(T)`,
// derived from the graph inside the write itself
// (tasks-core `withTaskStatusChange`). So a task that becomes launchable
// because something upstream moved gets its OWN event.
//
// And for an armed, attempt-less, undropped, unheld task, `blocked` is exactly
// the status it carries while it is not launchable. So "becomes launchable" and
// "leaves blocked" are the same event once the event is closure-correct — which
// is why the old two-case shape is gone: the armed-dependents fan-out has
// nothing left to find, and the `previousStatus === "blocked"` condition on the
// direct case would only re-exclude the un-dropped / un-held task it was meant
// to catch.
//
// The fan-out was not merely redundant — it was UNABLE to cover the case that
// motivated this: it walked `task_dependencies` for armed dependents of the
// settled task, and when the unblocking write was an edge REMOVAL, the walk ran
// over an edge that no longer existed and reached nobody.
//
// The armed-marker guard below is what keeps the now-wider event stream from
// amplifying into launch jobs: a settle on a task with 47 dependents emits up
// to 48 events, and all but the armed ones stop here on one indexed read.
// maybeLaunchTaskJob remains the exactly-once gate (dropped/held? armed?
// unblocked? unclaimed? no existing attempt?), so waking it for a task that
// turns out to be ineligible is a safe no-op.
//
// A consequence worth naming: this rule keys on NO status at all, so a new
// status is not something it has to be taught. `in_progress_blocked` arrived
// while this change was in flight and needed an `isBlockedStatus` predicate in
// the old `previousStatus === "blocked"` condition; here it needs nothing —
// maybeLaunchTaskJob asks `hasBlockingDep` directly rather than reading a
// status, so the gate cannot fall out of step with the status vocabulary.
//
// This intermediary job cannot be collapsed into maybeLaunchTaskJob itself: a
// Trigger's `with` is a static input, and `taskId` arrives on the separate
// `event` argument, so the launch job cannot bind to the event directly.
export const maybeLaunchOnStatusJob = defineJob({
  name: "tasks.maybe-launch-on-status",
  description:
    "Wakes the auto-launcher when an armed task's status changes, so a task starts as soon as its blockers resolve.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({
      taskId: z.string(),
      folderId: z.string().nullable(),
      status: TaskStatusSchema,
      previousStatus: TaskStatusSchema,
    })
    .passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    // Cheap indexed guard: the overwhelming majority of status changes are on
    // tasks nobody armed, and they cost one primary-key read each.
    if (!(await getTaskAutoStart(event.taskId))) return;
    await maybeLaunchTaskJob.enqueue({
      taskId: event.taskId,
      cause: "status-changed",
    });
  },
});

// Static trigger target for `tasks.autoStartArmed`: the task plugins arm a task
// (`armTaskAutoStart`) and emit the event rather than naming this plugin's
// launcher, so a host with no launcher arms and wakes nothing. Intermediary for
// the same reason as `maybeLaunchOnStatusJob`: a Trigger's `with` is static
// and `taskId` arrives on the event.
export const maybeLaunchOnArmedJob = defineJob({
  name: "tasks.maybe-launch-on-armed",
  description:
    "Wakes the auto-launcher when a task is armed for auto-launch, so it starts at once if nothing blocks it.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z.object({ taskId: z.string(), cause: z.string() }).passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    await maybeLaunchTaskJob.enqueue({
      taskId: event.taskId,
      cause: event.cause,
    });
  },
});

// Static trigger target for `conversation.statusChanged`: when an agent stops
// being busy (leaves `starting` / `working`), a slot under the host-wide launch
// cap may have opened, and the armed tasks `maybeLaunchTaskJob` turned away as
// `at-capacity` have no other event to wake them. Wake the oldest launchable
// armed tasks, as many as there are free slots — push-based, no polling.
//
// Oldest LAUNCHABLE, not oldest: an old armed task still blocked on a
// dependency (or held, or dropped) would take a freed slot nothing can use and
// leave it idle until the next event. The checks are cheap indexed reads, made
// one task at a time and stopped once the slots are filled (`takeLaunchable`).
// `maybeLaunchTaskJob` re-checks everything and its locked slot check is the
// authority, so a pick that went stale in between is a safe no-op.
//
// Intermediary for the same reason as `maybeLaunchOnStatusJob`: a Trigger's
// `with` is static and the conversation arrives on the event.
export const launchNextArmedJob = defineJob({
  name: "tasks.launch-next-armed",
  description:
    "When an agent finishes working, starts the armed tasks that were waiting for a free slot under the concurrent-agent cap, oldest first.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({
      conversationId: z.string(),
      status: ConversationStatusSchema,
      previousStatus: ConversationStatusSchema,
    })
    .passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    if (!releasedLaunchSlot(event.previousStatus, event.status)) return;
    // Main-only, like the launcher it wakes (see `maybeLaunchTaskJob`).
    if (!isMain()) return;
    const slots = await hostFreeLaunchSlots(db);
    if (slots === 0) return;
    const picked = await takeLaunchable(
      await listArmedTaskIds(),
      slots,
      isQueueLaunchable,
    );
    for (const taskId of picked) {
      await maybeLaunchTaskJob.enqueue({ taskId, cause: "slot-freed" });
    }
  },
});

// The queue gates `maybeLaunchTaskJob` waits on, as a predicate: the task
// exists, is neither dropped nor held, and nothing blocks it.
async function isQueueLaunchable(taskId: string): Promise<boolean> {
  const t = await getTask(taskId);
  if (!t || t.droppedAt || t.heldAt) return false;
  return !(await hasBlockingDep(taskId, db));
}
