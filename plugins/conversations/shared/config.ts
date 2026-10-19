import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { enumField } from "@plugins/fields/plugins/enum/plugins/config/core";
import {
  CONVERSATION_RUNTIMES,
  CONVERSATION_RUNTIME_IDS,
} from "@plugins/conversations/plugins/runtime-catalog/core";

export const autoAnswerConfig = defineConfig({
  name: "auto-answer",
  fields: {
    enabled: boolField({
      default: false,
      label: "Auto-open question prompts",
      description:
        'When an agent asks a question, automatically dismiss the terminal menu and surface the inline answer form in the conversation — no need to click "Answer here" first. You still type the answer yourself.',
    }),
  },
});

// Which runtime a conversation starts on when neither the launch nor its task
// names one (a fork or resume keeps its source's).
export const runtimeConfig = defineConfig({
  name: "conversation-runtime",
  fields: {
    defaultRuntime: enumField({
      options: CONVERSATION_RUNTIME_IDS.map((id) => ({
        value: id,
        label: CONVERSATION_RUNTIMES[id].label,
      })),
      default: "tmux",
      label: "Default runtime",
      description:
        "What a new conversation runs on unless its task picks one: the interactive CLI in a terminal (tmux), or a headless Agent SDK session (sdk).",
    }),
  },
});
