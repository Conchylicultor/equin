import noRawSpeechSynthesis from "./no-raw-speech-synthesis";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "speech-synthesis",
  rules: {
    "no-raw-speech-synthesis": noRawSpeechSynthesis,
  },
} satisfies LintContribution;
