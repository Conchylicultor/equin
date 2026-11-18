import { z } from "zod";
import { defineJob, isSuspendSignal } from "@plugins/infra/plugins/jobs/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { WorkspaceSpecSchema } from "@plugins/conversations/plugins/workspace/core";
import { Workspace } from "@plugins/conversations/plugins/workspace/server";
import { ConversationModelSchema } from "@plugins/conversations/plugins/model-provider/core";
import { EffortLevelSchema } from "@plugins/conversations/plugins/effort-provider/core";
import { ClaudeCodeUnavailableError } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import {
  clearSpawnFailure,
  recordSpawnFailure,
  spawnFailures,
} from "@plugins/conversations/plugins/spawn-failure/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import {
  abandonLaunch,
  openLaunch,
} from "@plugins/conversations/plugins/launch-timeline/server";
import { Runtime } from "./runtime";
import { spawnSystemPrompt } from "./spawn-system-prompt";
import { requestStatusReconcile } from "./status-reconciler";
import { handOverStarting } from "./spawn-handover";
import { typeLaunchTurn } from "./turns";

// Durable, self-healing conversation spawn. Mirrors `databaseForkJob`: the
// enqueue is a committed graphile-worker row, so an interrupted spawn (backend
// restart mid-spawn, or a crash between starting the agent and the job
// commit) re-runs when the worker reboots instead of leaving the conversation
// stuck `starting` with no session. Both steps are idempotent — the workspace's
// `prepare` (a worktree's checkout is made by the supervised `worktree.prepare`
// child, which a restart does not kill, and is only waited on here — durably,
// so the spawn resumes in whichever backend is alive when it ends) and
// `runtime.create` (no-ops once a live session exists) — which is the
// precondition that makes durable retry safe.
//
// Kept SEPARATE from whatever the workspace enqueued on commit (a worktree's
// `databaseForkJob`): the spawn does not depend on it, so they run in parallel.
export const spawnConversationJob = defineJob({
  name: "conversations.spawn",
  description:
    "Prepares the workspace (the git worktree) and starts the agent session for a new conversation.",
  // minutes: what stays in process is still unbounded by anything shorter than
  // the work — `runtime.create` starting the agent process. The checkout and
  // its install are not here: the workspace's `prepare` waits for them with
  // `ctx.waitFor`, which releases the slot.
  hold: "minutes",
  inProcess:
    "The checkout and its install run in the supervised worktree.prepare child, which a restart does not kill; " +
    "what stays here is safe under a kill — `runtime.create` no-ops once a live session exists — " +
    "so a spawn killed by a restart re-runs and skips whatever already landed.",
  input: z.object({
    conversationId: z.string(),
    attemptId: z.string(),
    worktreePath: z.string(),
    // Defaulted for a job enqueued before the field existed: every one of those
    // was a worktree launch.
    workspace: WorkspaceSpecSchema.default({ kind: "worktree" }),
    runtimeId: z.string(),
    create: z.object({
      model: ConversationModelSchema,
      effort: EffortLevelSchema.optional(),
      resumeSessionId: z.string().optional(),
      forkSession: z.boolean(),
    }),
  }),
  // Direct-enqueue only (kicked off by createConversation's new-attempt branch).
  event: z.never(),
  // jobKey "conversations.spawn:<conversationId>" — replace-if-not-running.
  dedup: { key: (input) => input.conversationId },
  maxAttempts: 5,
  // No attempt of this launch will come again — its last attempt threw, its
  // worker died on its last attempt (a restart mid-spawn), the wake-up from
  // its checkout wait failed, or its row was removed. That is the fact that
  // ends `starting`: the launch is recorded as failed, with why, and the
  // status reconciler is asked about this row now. By then the run no longer
  // counts as `inFlight`, so the reconcile moves the row to `gone` showing the
  // failure — never a row left `starting` with nothing coming for it.
  onDead: async ({ input: { conversationId, runtimeId }, death }) => {
    // Its agent may already run: the spawn starts it in the workspace's files
    // before the workspace is ready. Stopped first — left running, the next
    // reconcile would take the row up as a live agent and flush the held
    // launch prompt into a workspace that never became ready.
    const runtime = Runtime.get(runtimeId);
    if (await runtime.isRunning(conversationId))
      await runtime.delete(conversationId);
    // `failed`: the body's catch below recorded its last attempt's failure,
    // with the step that threw — kept, unless that write itself failed. Every
    // other death bypassed the body.
    if (
      death.cause !== "failed" ||
      (await spawnFailures.get(conversationId)) === undefined
    ) {
      await recordSpawnFailure(conversationId, "job", death.error);
    }
    // No agent of this launch will start: a later one (a resume) is not it.
    await abandonLaunch(conversationId);
    requestStatusReconcile([conversationId]);
  },
  run: async ({
    input: {
      conversationId,
      attemptId,
      worktreePath,
      workspace: spec,
      runtimeId,
      create,
    },
    ctx,
  }) => {
    const { signal } = ctx;
    const at = { attemptId, path: worktreePath, spec };
    // Which step threw, for the report: the checkout and the session start fail
    // for different reasons and are fixed in different places. ("worktree"
    // names the workspace's `prepare`, the value stored report rows carry.)
    let step: "worktree" | "runtime" = "worktree";
    // The WHOLE body is inside the try: every failure of an attempt is
    // recorded by the catch, which is what `onDead` relies on for a `failed`
    // death.
    try {
      // Closed (or deleted) before its agent started: the user is done with
      // it, so no agent may start for it now — a retry that ran anyway would
      // leave a process working for a conversation nothing shows or reaps.
      const row = await getConversation(conversationId);
      if (!row || row.status === "done") return;
      // The launch record: every phase from here to the first token lands on
      // it (launch-timeline). Opened once — a retry keeps the first run's.
      await openLaunch(conversationId, attemptId, row.createdAt);
      const workspace = Workspace.get(spec.kind);
      const runtime = Runtime.get(runtimeId);
      // The agent's process starts as soon as the workspace's files exist
      // (its cwd), not once the workspace is ready: Claude Code's own startup
      // (~4 s, the same in an empty dir) then runs while the workspace's
      // `prepare` finishes what only the first turn needs — a checkout's
      // install and index refresh. It starts with no prompt, and the row
      // stays `starting` (plan-update: a spawn in flight holds it), so every
      // turn — the launch prompt and anything sent meanwhile — stays held:
      // nothing reaches the agent, and no tool call runs its guards, before
      // the workspace is ready.
      //
      // Idempotent: called again on a replay of `prepare` (each wake of a
      // suspended spawn re-walks it), and a retry whose earlier attempt
      // already started the agent finds it running.
      let filesReady = false;
      const startAgent = async (): Promise<void> => {
        step = "runtime";
        if (!(await runtime.isRunning(conversationId))) {
          // Composed at the spawn, never at enqueue: a job retried after a
          // restart starts on what is true now (system-prompt).
          const appendSystemPrompt = await spawnSystemPrompt(conversationId);
          await runtime.create(
            conversationId,
            worktreePath,
            workspace.launch(at, { conversationId }),
            { ...create, appendSystemPrompt },
          );
        }
        filesReady = true;
        step = "worktree";
      };
      // Both are idempotent, so a mid-step crash re-runs the whole body safely.
      // The job's context goes down whole: its deadline for the work, and its
      // step / wait log for a kind that waits on a supervised child (which
      // suspends this job, through the catch below).
      await workspace.prepare(at, {
        signal: ctx.signal,
        step: ctx.step,
        waitFor: ctx.waitFor,
        sleep: ctx.sleep,
        conversationId,
        filesReady: startAgent,
      });
      if (!filesReady) {
        throw new Error(
          `The ${spec.kind} workspace's prepare returned without calling filesReady, so no agent was started for ${conversationId} — every workspace kind must call it before its prepare returns`,
        );
      }
      step = "runtime";
      // A session runs in a ready workspace: an earlier attempt's failure no
      // longer describes it. Before the prompt, so nothing after it can fail
      // this attempt — `onDead` stops the agent of a launch that died, which
      // must never be one that already took its prompt.
      await clearSpawnFailure(conversationId);
      // The workspace is ready: the oldest held turn — the launch's own
      // prompt (kind `launch`), else one the user sent while this was
      // starting — goes to the agent now (path A of held-turn delivery,
      // turns.ts). The rest wait for the flush the status flip triggers.
      await typeLaunchTurn(conversationId, runtime);
      // Done with the row: the reconciler takes it out of `starting` now,
      // rather than once the queue completes this run.
      handOverStarting(conversationId);
      requestStatusReconcile([conversationId]);
    } catch (err) {
      // A suspend is the workspace's `prepare` waiting on its checkout, not a
      // failure: passed through untouched, before anything is recorded.
      if (isSuspendSignal(err)) throw err;
      // Claude Code went missing between the launch's check and this spawn.
      // Retrying cannot help until the user installs it, so say that — with
      // the fix — and stop. The job completes, so no spawn is in flight any
      // more: the status reconciler moves the row to `gone` showing this
      // failure, from where Resume works once Claude Code is back.
      if (err instanceof ClaudeCodeUnavailableError) {
        await recordSpawnFailure(conversationId, step, err.message);
        await abandonLaunch(conversationId);
        await recordReport({
          kind: "claude-code-unavailable-at-spawn",
          source: "server-caught",
          message: `${conversationId}: ${err.message}`,
          data: { conversationId, error: err.message },
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // The latest attempt's failure, on the conversation itself: once the
      // status sweep moves the row to `gone`, it is what tells a launch that
      // never started apart from a session that ended.
      await recordSpawnFailure(conversationId, step, message);
      await recordReport({
        kind: "conversation-spawn-failed",
        source: "server-caught",
        message: `${conversationId}: ${message}`,
        data: {
          conversationId,
          attemptId,
          worktreePath,
          runtimeId,
          step,
          deadlineAborted: signal.aborted,
          errorType: err instanceof Error ? err.name : typeof err,
          error: err instanceof Error && err.stack ? err.stack : message,
        },
      });
      // Rethrow so graphile retries (and dead-letters after maxAttempts —
      // observable in Debug → Queue + queue-health). While a retry is still
      // coming the status reconciler leaves the row `starting`
      // (`spawnConversationJob.inFlight`); once the job gives up, `onDead`
      // asks it to settle the row now, and it is the single writer of
      // `starting → gone` — and resurrects a `gone` row the moment its agent
      // is found running.
      throw err;
    }
  },
});
