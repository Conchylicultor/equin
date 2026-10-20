import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { userTurnSent } from "@plugins/conversations/plugins/turn-ledger/server";
import {
  conversationCreated,
  taskTitleChanged,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  titleOnConversationCreatedJob,
  titleOnUserTurnSentJob,
} from "./internal/title-subscribers";
import { taskShortTitlesServed } from "./internal/short-title-resource";
import {
  shortTitleJob,
  shortTitleOnTitleChangedJob,
} from "./internal/short-title-job";
import {
  backfillShortTitlesJob,
  shortTitlesBackfillWarmup,
} from "./internal/short-title-backfill";

export {
  scheduleTaskTitleUpdate,
  scheduleTaskTitleUpgrade,
  synthesiseTitleFallback,
} from "./internal/generate-title";

export default {
  description:
    "Haiku-backed task title generation. Upgrades uninformative titles asynchronously via event subscribers so task/conversation creation never blocks on the Claude CLI round-trip. One Haiku call reads the full description and makes both the title and a ≤3-word short title (stored in the tasks_ext_short_title side-table); a title set by hand gets its short title from the same call on tasks.titleChanged, and recently active tasks are backfilled.",
  register: [
    titleOnConversationCreatedJob,
    titleOnUserTurnSentJob,
    shortTitleJob,
    shortTitleOnTitleChangedJob,
    backfillShortTitlesJob,
    shortTitlesBackfillWarmup,
  ],
  contributions: [
    ...taskShortTitlesServed.declare,
    Trigger({
      on: conversationCreated,
      do: titleOnConversationCreatedJob,
      with: {},
      oneShot: false,
    }),
    Trigger({
      on: userTurnSent,
      do: titleOnUserTurnSentJob,
      with: {},
      oneShot: false,
    }),
    Trigger({
      on: taskTitleChanged,
      do: shortTitleOnTitleChangedJob,
      with: {},
      oneShot: false,
    }),
  ],
} satisfies ServerPluginDefinition;
