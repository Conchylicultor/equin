import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { PHASE_ORDER, type ConversationPhase } from "../../core";
import { conversationProgress } from "../../server/internal/tables";

import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

async function gitRun(
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string | null> {
  // Bounded by the job's own `ctx.signal` rather than a local number: these are
  // ordinary local reads with no duration of their own worth naming, and the
  // thing that should end them is the run being given up on. An abort THROWS
  // out of here rather than returning null, which is what stops the two reads
  // after this one from being started after we were told to stop.
  const result = await spawnCaptured(
    [GIT, "--no-optional-locks", "-C", cwd, ...args],
    { signal },
  );
  return result.exitCode === 0 ? result.stdout : null;
}

// - research:      no files modified vs main
// - design:        only research/** files modified
// - implementation: any non-research file modified
async function detectPhase(
  worktreePath: string,
  signal: AbortSignal,
): Promise<ConversationPhase> {
  const base = (
    await gitRun(["merge-base", "main", "HEAD"], worktreePath, signal)
  )?.trim();
  if (!base) return "research";

  // Committed + staged + unstaged changes vs merge-base in one pass
  const changed = await gitRun(
    ["diff", "--name-only", base],
    worktreePath,
    signal,
  );
  // New untracked files
  const untracked = await gitRun(
    ["ls-files", "--others", "--exclude-standard"],
    worktreePath,
    signal,
  );

  const files = [
    ...(changed?.split("\n") ?? []),
    ...(untracked?.split("\n") ?? []),
  ].filter(Boolean);

  if (files.length === 0) return "research";
  if (files.some((f) => !f.startsWith("research/"))) return "implementation";
  return "design";
}

// Triggered on every conversationTurnCompleted. Derives the phase from the
// worktree's git state — no LLM call needed.
export const classifyProgressJob = defineJob({
  name: "conversation-progress.classify",
  description:
    "Works out whether a conversation is researching, designing or implementing by checking which files its branch has changed.",
  // seconds: three git subprocesses (merge-base / diff / ls-files), each bound
  // to this run's own `ctx.signal`. They are bounded local reads over one
  // worktree — not an open-ended step machine — so this is the class below
  // `minutes`, and the class deadline is what ends them if they hang.
  hold: "seconds",
  input: z.object({}).passthrough(),
  event: z.object({ conversationId: z.string() }).passthrough(),
  dedup: "none",
  maxAttempts: 2,
  run: async ({ event, ctx: { signal } }) => {
    const conversationId = event?.conversationId;
    if (!conversationId) return;

    const conversation = await getConversation(conversationId);
    if (!conversation?.worktreePath) return;

    const newPhase = await detectPhase(conversation.worktreePath, signal);

    const prior = await conversationProgress.get(conversationId);
    const currentIndex = prior
      ? PHASE_ORDER.indexOf(prior.phase as ConversationPhase)
      : -1;
    if (PHASE_ORDER.indexOf(newPhase) <= currentIndex) return;

    await conversationProgress.upsert(conversationId, {
      phase: newPhase,
      source: "heuristic",
    });
  },
});
