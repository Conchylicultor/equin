import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import {
  conversationCreated,
  conversationStatusChanged,
  taskStatusChanged,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  watchChildrenCapability,
  watchTreeCapability,
} from "./internal/capability";
import {
  watchDeliverJob,
  watchIngestJob,
  watchManagersReconcileJob,
  watchManagersReconcileWarmup,
  watchOnConversationCreatedJob,
  watchOnConversationStatusJob,
  watchOnTaskStatusJob,
  watchQuietJob,
} from "./internal/jobs";

export { watchSource } from "./internal/source";

export default {
  description:
    "Watch, desktop-only half — where agents run: watchSource() (a WatchSource paired with the trigger feeding watch.ingest, which routes each event to the nearest live watch above its task, never the actor's own); watch.quiet (one `quiet` event when a watched subtree stops having busy agents or launchable armed tasks, re-checked on task and conversation status changes); watch.deliver (a watch's events merged into ONE `event` turn with the tree digest for an idle agent watcher, or one batch for a WatchHandler); the watch.tree take-over (an agent starting on a mandate root granting watch.tree becomes the one watching the whole tree); and the watch.children / watch.tree capabilities' describe.",
  contributions: [
    watchChildrenCapability,
    watchTreeCapability,
    Trigger({
      on: conversationCreated,
      do: watchOnConversationCreatedJob,
      with: {},
      oneShot: false,
    }),
    Trigger({
      on: taskStatusChanged,
      do: watchOnTaskStatusJob,
      with: {},
      oneShot: false,
    }),
    Trigger({
      on: conversationStatusChanged,
      do: watchOnConversationStatusJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [
    watchIngestJob,
    watchQuietJob,
    watchDeliverJob,
    watchOnTaskStatusJob,
    watchOnConversationStatusJob,
    watchOnConversationCreatedJob,
    watchManagersReconcileJob,
    watchManagersReconcileWarmup,
  ],
} satisfies MachinePluginDefinition;
