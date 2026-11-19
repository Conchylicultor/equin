import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  speechSupport,
  type SpeechSupport,
  type SpeakOptions,
} from "./internal/speech-support";

export default {
  description:
    "The browser's speech synthesis (Web Speech API), only where it exists: speechSupport(win?) answers unsupported (some Android browsers, in-app webviews and privacy-hardened builds have no speechSynthesis) or supported with speak(text, options) and cancel() — so a caller must branch before it can speak, and goes silent where the browser cannot talk. Its lint rule (no-raw-speech-synthesis) sends every other speechSynthesis / SpeechSynthesisUtterance use here.",
  contributions: [],
} satisfies PluginDefinition;
