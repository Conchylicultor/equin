import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationTurnCompleted } from "@plugins/conversations/server";
import { classifyConversationJob } from "./internal/classify-job";
import { handleClassify, handleSetCategory } from "./internal/routes";
import {
  classifyConversation,
  setConversationCategory,
} from "../shared/endpoints";

export default {
  description:
    "Conversation categories, desktop-only half: the Haiku classifier (its job and the turn-completed trigger) and the classify and set routes (both read the config the portable half registers).",
  contributions: [
    Trigger({
      on: conversationTurnCompleted,
      do: classifyConversationJob,
      with: {},
      oneShot: false,
    }),
  ],
  httpRoutes: {
    [classifyConversation.route]: handleClassify,
    [setConversationCategory.route]: handleSetCategory,
  },
  register: [classifyConversationJob],
} satisfies MachinePluginDefinition;
