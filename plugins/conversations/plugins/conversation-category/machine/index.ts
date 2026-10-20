import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
// Registers the configured icons' saved-icon source (module eval).
import "./internal/saved-icons";
import { ConfigV2 } from "@plugins/config_v2/server";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationTurnCompleted } from "@plugins/conversations/server";
import { conversationCategoryConfig } from "../shared/config";
import { classifyConversationJob } from "./internal/classify-job";
import { handleClassify, handleSetCategory } from "./internal/routes";
import {
  classifyConversation,
  setConversationCategory,
} from "../shared/endpoints";

export default {
  description:
    "Conversation categories, desktop-only half: the categories config, the Haiku classifier (its job and the turn-completed trigger), the classify and set routes (both read the config), and the configured avatars' saved-icon source.",
  contributions: [
    ConfigV2.Register({ descriptor: conversationCategoryConfig }),
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
