import { db } from "@plugins/database/server";
import {
  setTaskCategory,
  TaskCategory,
} from "@plugins/tasks/plugins/task-category/server";
import {
  _attempts,
  _conversations,
  createTask,
  insertPush,
} from "@plugins/tasks/plugins/tasks-core/server";
import { upsertRank } from "@plugins/conversations/plugins/conversations-view/plugins/queue/server";
import { writeTranscript } from "@plugins/conversations/plugins/transcript-source/plugins/memory/server";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { setTaskTrack } from "@plugins/tasks/plugins/task-track/server";
import { tasksShortTitle } from "@plugins/tasks/plugins/task-title/server";
import { conversationNotes } from "@plugins/conversations/plugins/conversation-view/plugins/notes/server";
import { conversationProgress } from "@plugins/conversations/plugins/conversation-progress/server";
import {
  _agent_launches,
  _agents,
  nextAgentRankUnder,
} from "@plugins/conversations/plugins/agents/server";
import {
  DEMO_AGENTS,
  DEMO_STORIES,
  demoAgentId,
  demoAgentLaunchId,
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
 * Code JSONL, and, for a finished story, the push that landed it; its short
 * title, track, progress and note; and the roster of agents with the launch of
 * each story an agent filed.
 */
export async function seed(): Promise<void> {
  assertStoryCategoriesRegistered();
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms);
  const live = DEMO_STORIES.filter((s) => s.status !== "done");
  const ranks = Rank.nBetween(null, null, live.length);
  for (const agent of DEMO_AGENTS) {
    await db.insert(_agents).values({
      id: demoAgentId(agent),
      parentId: null,
      name: agent.name,
      prompt: agent.prompt,
      model: null,
      icon: null,
      iconColor: null,
      rank: (await nextAgentRankUnder(null)).toJSON(),
    });
  }
  for (const story of DEMO_STORIES) {
    const taskId = demoTaskId(story);
    const attemptId = demoAttemptId(story);
    const conversationId = demoConversationId(story);
    await createTask({ id: taskId, title: story.task, titleAuto: false });
    if (story.category !== undefined)
      await setTaskCategory(taskId, story.category);
    await tasksShortTitle.upsert(taskId, {
      shortTitle: story.shortTitle,
      sourceTitle: story.task,
    });
    if (story.track !== undefined) await setTaskTrack(taskId, story.track);
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
    await conversationProgress.upsert(conversationId, {
      phase: story.phase,
      source: story.phase === "pushed" ? "push" : "heuristic",
    });
    if (story.note !== undefined)
      await conversationNotes.upsert(conversationId, { notes: story.note });
    if (story.agent !== undefined) {
      const agent = DEMO_AGENTS.find((a) => a.key === story.agent);
      if (agent === undefined)
        throw new Error(
          `demo story "${story.key}" names agent "${story.agent}", which DEMO_AGENTS does not list`,
        );
      await db.insert(_agent_launches).values({
        id: demoAgentLaunchId(story),
        agentId: demoAgentId(agent),
        taskId,
        createdAt: ago(story.startedAgo),
      });
    }
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

/**
 * Every story's category is one this host registers (`TaskCategory`): a task
 * filed under a category no booted plugin registers renders as its raw id —
 * the demo's task list would group under "apps" instead of a label. Loud, at
 * seed, so the boot test fails the moment the composition drops a registrar.
 */
function assertStoryCategoriesRegistered(): void {
  const registered = new Set(TaskCategory.getContributions().map((c) => c.id));
  const missing = [
    ...new Set(
      DEMO_STORIES.flatMap((s) =>
        s.category !== undefined && !registered.has(s.category)
          ? [s.category]
          : [],
      ),
    ),
  ];
  if (missing.length > 0) {
    throw new Error(
      `[demo seed] stories are filed under task categories this host does not register: ${missing.join(", ")} (registered: ${[...registered].sort().join(", ")}). File them under a category a graph member contributes (TaskCategory), or bring its registrar into the composition.`,
    );
  }
}
