import { db } from "@plugins/database/server";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import {
  _attempts,
  _conversations,
  createTask,
  insertPush,
} from "@plugins/tasks/plugins/tasks-core/server";
import { upsertRank } from "@plugins/conversations/plugins/conversations-view/plugins/queue/server";
import { writeTranscript } from "@plugins/conversations/plugins/transcript-source/plugins/memory/server";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  DEMO_STORIES,
  demoAttemptId,
  demoConversationId,
  demoTaskId,
  demoTranscriptJsonl,
  demoWorktreePath,
} from "../core";

/**
 * The demo's starting data on the freshly migrated database, one agent per
 * story (`../core`): its task and category, the attempt and conversation it
 * runs in — backdated to the story's clock, which no mutation can do, so those
 * two are inserted as rows — its place in the queue, its transcript as Claude
 * Code JSONL, and, for a finished story, the push that landed it.
 */
export async function seed(): Promise<void> {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms);
  const live = DEMO_STORIES.filter((s) => s.status !== "done");
  const ranks = Rank.nBetween(null, null, live.length);
  for (const story of DEMO_STORIES) {
    const taskId = demoTaskId(story);
    const attemptId = demoAttemptId(story);
    const conversationId = demoConversationId(story);
    await createTask({ id: taskId, title: story.task, titleAuto: false });
    if (story.category !== undefined)
      await setTaskCategory(taskId, story.category);
    await db.insert(_attempts).values({
      id: attemptId,
      taskId,
      worktreePath: demoWorktreePath(story),
      createdAt: ago(story.startedAgo),
      updatedAt: ago(story.updatedAgo),
    });
    await db.insert(_conversations).values({
      id: conversationId,
      attemptId,
      title: story.title,
      status: story.status,
      workingOn: story.status === "working" ? "turn" : null,
      model: story.model,
      createdAt: ago(story.startedAgo),
      updatedAt: ago(story.updatedAgo),
      endedAt: story.endedAgo === undefined ? null : ago(story.endedAgo),
      lastViewedAt: ago(story.updatedAgo),
    });
    await writeTranscript(conversationId, demoTranscriptJsonl(story, now));
    if (story.endedAgo !== undefined)
      await insertPush({
        id: `push-demo-${story.key}`,
        attemptId,
        conversationId,
        sha: `demo${story.key}`.padEnd(40, "0").slice(0, 40),
        pushId: `push-demo-${story.key}`,
        message: story.title,
        createdAt: ago(story.endedAgo),
      });
  }
  for (const [i, story] of live.entries())
    await upsertRank(demoConversationId(story), ranks[i]!);
}
