import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
// Side-effect registration only: eagerly registers the boot-critical
// tasks / attempts / conversations-* web descriptors (see ./internal/register).
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

export default {
  collapsed: true,
  description:
    "tasks-core web presence: eagerly registers the boot-critical tasks / attempts / conversations-* resource descriptors so boot-snapshot can hydrate them before first paint, and owns the client-side reads of them (useTaskAttempts / useTaskConversations, the one join from a task to the attempts and runs it produced).",
  contributions: [
    // The exposed `mandate` field (every task's effective named mandate).
    mandatePresentation,
    IdKinds.Kind({ kind: taskIdKind }),
    IdKinds.Kind({ kind: attemptIdKind }),
    IdKinds.Kind({ kind: conversationIdKind }),
  ],
} satisfies PluginDefinition;
