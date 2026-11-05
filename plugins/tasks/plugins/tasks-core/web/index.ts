import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
// Side-effect registration only: eagerly registers the boot-critical
// tasks / conversations-* web descriptors (see ./internal/register).
// tasks-core is the schema/repository layer — it has no UI of its own, but it
// does own how its own resources are READ: the task -> attempts -> runs join
// lives in ./hooks rather than being re-derived by every surface showing it.
import "./internal/register";
import { IdKinds } from "@plugins/ids/web";
import { mandatePresentation } from "./internal/mandate-presentation";
import {
  attemptIdKind,
  conversationIdKind,
  taskIdKind,
} from "@plugins/tasks/plugins/task-ids/core";

export { useTaskAttempts, useTaskConversations } from "./hooks";
export { useTaskCluster, type TaskCluster } from "./cluster";

export default {
  collapsed: true,
  description:
    "tasks-core web presence: eagerly registers the boot-critical conversations-* / tasks.v2 resource descriptors so boot-snapshot can hydrate them before first paint, and owns the client-side reads of them (useTaskAttempts / useTaskConversations, the one join from a task to the attempts and runs it produced, each a read of the task's own scope; useTaskCluster, a task's dependency cluster — its row, then its cluster's rows — with the dependency graph over them).",
  contributions: [
    // The exposed `mandate` field (every task's effective named mandate).
    mandatePresentation,
    IdKinds.Kind({ kind: taskIdKind }),
    IdKinds.Kind({ kind: attemptIdKind }),
    IdKinds.Kind({ kind: conversationIdKind }),
  ],
} satisfies PluginDefinition;
