import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { recordReport } from "@plugins/reports/server";
import { WorkspaceSpecSchema } from "@plugins/conversations/plugins/workspace/core";
import { Workspace } from "@plugins/conversations/plugins/workspace/server";
import { ConversationModelSchema } from "@plugins/conversations/plugins/model-provider/core";
import { EffortLevelSchema } from "@plugins/conversations/plugins/effort-provider/core";
import { ClaudeCodeUnavailableError } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import {
  clearSpawnFailure,
  recordSpawnFailure,
} from "@plugins/conversations/plugins/spawn-failure/server";
import { Runtime } from "./runtime";
import { launchWithHeldTurn } from "./turns";

// Durable, self-healing conversation spawn. Mirrors `databaseForkJob`: the
// enqueue is a committed graphile-worker row, so an interrupted spawn (backend
// restart mid-checkout, or a crash between starting the agent and the job
// commit) re-runs when the worker reboots instead of leaving the conversation
// stuck `starting` with no session. Both steps are idempotent — the workspace's
// `prepare` (`setupWorktree` no-ops once the checkout landed, and redoes a
// spare claim a kill left unfinished) and
// `runtime.create` (no-ops once a live session exists) — which is the
// precondition that makes durable retry safe.
//
// Kept SEPARATE from whatever the workspace enqueued on commit (a worktree's
// `databaseForkJob`): the spawn does not depend on it, so they run in parallel.
export const spawnConversationJob = defineJob({
  name: "conversations.spawn",
  description:
    "Prepares the workspace (the git worktree) and starts the agent session for a new conversation.",
  // minutes: preparing a worktree is a `git worktree add` checkout and
  // `runtime.create` starts the agent process. Nothing
  // shorter than the work bounds either.
  hold: "minutes",
  inProcess:
    "Both steps are idempotent — the workspace's prepare no-ops once the checkout exists " +
    "and `runtime.create` no-ops once a live session exists — so a spawn killed " +
    "by a restart simply re-runs and skips whatever already landed.",
  input: z.object({
    conversationId: z.string(),
    attemptId: z.string(),
    worktreePath: z.string(),
    // Defaulted for a job enqueued before the field existed: every one of those
    // was a worktree launch.
    workspace: WorkspaceSpecSchema.default({ kind: "worktree" }),
    runtimeId: z.string(),
    create: z.object({
      prompt: z.string().optional(),
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
  run: async ({
    input: {
      conversationId,
      attemptId,
      worktreePath,
      workspace: spec,
      runtimeId,
      create,
    },
    ctx: { signal },
  }) => {
    const at = { attemptId, path: worktreePath, spec };
    const workspace = Workspace.get(spec.kind);
    // Which step threw, for the report: the checkout and the session start fail
    // for different reasons and are fixed in different places. ("worktree"
    // names the workspace's `prepare`, the value stored report rows carry.)
    let step: "worktree" | "runtime" = "worktree";
    try {
      // The workspace's `prepare` (git worktree add) MUST precede
      // `runtime.create`: the agent's cwd must exist.
      // Both are idempotent, so a mid-step crash re-runs the whole body safely.
      // `signal` is this dispatch's deadline, handed down to the work.
      await workspace.prepare(at, signal);
      step = "runtime";
      const runtime = Runtime.get(runtimeId);
      // A retry whose earlier attempt already started the session: `create`
      // would no-op, so a held turn claimed here would never reach the agent.
      // Leave every held turn to the flush the status flip triggers.
      if (!(await runtime.isRunning(conversationId))) {
        // Path A of held-turn delivery (turns.ts): the oldest held turn — the
        // launch's own prompt (kind `launch`), else one the user sent while
        // this was starting — becomes the launch message, behind the baked
        // preprompt block `create.prompt` carries, so Claude starts on it
        // directly instead of idling at an empty prompt.
        await launchWithHeldTurn(conversationId, create.prompt, (prompt) =>
          runtime.create(
            conversationId,
            worktreePath,
            workspace.launch(at, { conversationId }),
            { ...create, prompt },
          ),
        );
      }
      // A session runs: an earlier attempt's failure no longer describes it.
      await clearSpawnFailure(conversationId);
    } catch (err) {
      // Claude Code went missing between the launch's check and this spawn.
      // Retrying cannot help until the user installs it, so say that — with
      // the fix — and stop. The row stays `starting`, and the status
      // sweep's starting timeout moves it to `gone`, from where Resume works once
      // Claude Code is back.
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
      // observable at /api/jobs + queue-health). On exhaustion the row is left
      // `starting`; the status reconciler is the single writer of `starting → gone` and
      // resurrects the row if a late retry finally spawns the session.
      throw err;
    }
  },
});
