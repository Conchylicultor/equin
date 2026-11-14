import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { RankExecutor } from "@plugins/primitives/plugins/rank/server";
import type { ConversationSectionId } from "../../core";
import { sectionExists } from "./sections";

/**
 * Where a task group is filed before it has a seat: asked by the seed job for
 * the FIRST live conversation of a task (a conversation joining an existing
 * group takes that group's section instead). A contributor answers for the
 * tasks it knows — a supervisor role's new session lands in the role's
 * section — and `null` for every other one.
 *
 * The section is a user section's id; the contributor keeps it valid (a
 * foreign key with ON DELETE SET NULL), and the seed job asserts it exists.
 */
export interface QueueLaunchSection {
  /** Stable id (the contributing plugin's own name for it). */
  id: string;
  sectionFor(
    taskId: string,
    executor: RankExecutor,
  ): Promise<ConversationSectionId | null>;
}

export const Queue = {
  LaunchSection: defineServerContribution<QueueLaunchSection>(
    "conversations.conversations-view.queue.launch-section",
    { docLabel: (s) => s.id },
  ),
};

/**
 * The section a task's first conversation is seated in: the one contributed
 * answer, or the Queue (`null`). Two contributors answering for one task is a
 * loud error — the group would land in whichever was asked first.
 */
export async function launchSectionFor(
  taskId: string,
  executor: RankExecutor,
): Promise<ConversationSectionId | null> {
  const answers: { id: string; section: ConversationSectionId }[] = [];
  for (const c of Queue.LaunchSection.getContributions()) {
    const section = await c.sectionFor(taskId, executor);
    if (section !== null) answers.push({ id: c.id, section });
  }
  if (answers.length > 1)
    throw new Error(
      `Task ${taskId} has a launch section from several contributors: ${answers.map((a) => `${a.id} → ${a.section}`).join(", ")}.`,
    );
  const answer = answers[0];
  if (answer === undefined) return null;
  if (!(await sectionExists(answer.section, executor)))
    throw new Error(
      `Launch section ${answer.section} (from ${answer.id}) for task ${taskId} does not exist.`,
    );
  return answer.section;
}
