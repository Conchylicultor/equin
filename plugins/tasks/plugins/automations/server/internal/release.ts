import { catalogChanged } from "./catalog-changed";
import { markLaunchReleased } from "./origin";
import { registeredAutomation } from "./registry";

/**
 * `taskId` gives its launch-kind automation's slot back — its agent is done
 * with what it was launched for (e.g. it submitted its report), even though
 * its conversation stays open for a person to read. Wakes the automation that
 * launched it, so the next task starts. Returns whether a slot was released:
 * `false` for a task no automation launched (one a person started, or one a
 * file-kind automation filed) or one already released — nothing to give back.
 */
export async function releaseLaunchedTask(taskId: string): Promise<boolean> {
  const automationId = await markLaunchReleased(taskId);
  if (automationId === null) return false;
  catalogChanged();
  // Absent from this composition ⇒ nothing here to start the next task.
  registeredAutomation(automationId)?.wake();
  return true;
}
