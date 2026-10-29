import { setTaskAutoStart } from "@plugins/tasks/plugins/auto-start/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { clearTaskAutoStart } from "@plugins/tasks/plugins/auto-start/core";

// Clear the autoStart marker on a single task — the whole disarm. Nothing else
// needs undoing: there are no per-task trigger rows to reverse-walk, only the
// one static `tasks.statusChanged` subscription, and a wake-up for a task with
// no marker stops on that check without launching.
export const handleClearAutoStart = implement(
  clearTaskAutoStart,
  async ({ params }) => {
    const ok = await setTaskAutoStart(params.id, null);
    if (!ok) throw new HttpError(404, "Not found");
    // return undefined → implement() sends 204
  },
);
