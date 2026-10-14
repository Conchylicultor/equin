import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { PromptEditorSlots } from "@plugins/primitives/plugins/prompt-editor/web";
import { VoiceInputButton } from "./components/voice-input-button";

export default {
  description: "Voice dictation for the prompt editor via the Web Speech API.",
  contributions: [
    PromptEditorSlots.FloatingAction({
      id: "voice-input",
      requires: [],
      component: VoiceInputButton,
    }),
  ],
} satisfies PluginDefinition;
