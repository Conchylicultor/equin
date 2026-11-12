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
import { Runtime } from "./runtime";
import { spawnSystemPrompt } from "./spawn-system-prompt";
import { requestStatusReconcile } from "./status-reconciler";
import { launchWithHeldTurn } from "./turns";

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
  onDead: async ({ input: { conversationId }, death }) => {
    // `failed`: the body's catch below recorded its last attempt's failure,
    // with the step that threw — kept, unless that write itself failed. Every
    // other death bypassed the body.
    if (
      death.cause !== "failed" ||
      (await spawnFailures.get(conversationId)) === undefined
    ) {
      await recordSpawnFailure(conversationId, "job", death.error);
    }
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
      const workspace = Workspace.get(spec.kind);
      // The workspace's `prepare` (git worktree add) MUST precede
      // `runtime.create`: the agent's cwd must exist.
      // Both are idempotent, so a mid-step crash re-runs the whole body safely.
      // The job's context goes down whole: its deadline for the work, and its
      // step / wait log for a kind that waits on a supervised child (which
      // suspends this job, through the catch below).
      await workspace.prepare(at, ctx);
      step = "runtime";
      const runtime = Runtime.get(runtimeId);
      // A retry whose earlier attempt already started the session: `create`
      // would no-op, so a held turn claimed here would never reach the agent.
      // Leave every held turn to the flush the status flip triggers.
      if (!(await runtime.isRunning(conversationId))) {
        // Path A of held-turn delivery (turns.ts): the oldest held turn — the
        // launch's own prompt (kind `launch`), else one the user sent while
        // this was starting — becomes the launch message, so Claude starts on
        // it directly instead of idling at an empty prompt.
        // Composed at the spawn, never at enqueue: a job retried after a
        // restart starts on what is true now (system-prompt).
        const appendSystemPrompt = await spawnSystemPrompt(conversationId);
        await launchWithHeldTurn(conversationId, (prompt) =>
          runtime.create(
            conversationId,
            worktreePath,
            workspace.launch(at, { conversationId }),
            { ...create, appendSystemPrompt, prompt },
          ),
        );
      }
      // A session runs: an earlier attempt's failure no longer describes it.
      await clearSpawnFailure(conversationId);
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
