import {
  ConversationRuntimeIdSchema,
  type ConversationRuntimeId,
} from "@plugins/conversations/plugins/runtime-catalog/core";
import { defineLaunchOption } from "@plugins/tasks/plugins/launch-options/core";

/**
 * Which runtime the task's conversations start on. `null` = the configured
 * default (`conversation-runtime.defaultRuntime`).
 */
export const runtimeLaunchOption =
  defineLaunchOption<ConversationRuntimeId | null>({
    id: "runtime",
    schema: ConversationRuntimeIdSchema.nullable(),
    defaultValue: null,
  });
