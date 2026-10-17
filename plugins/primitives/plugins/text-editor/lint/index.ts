import noFlushingEditorRead from "./no-flushing-editor-read";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "text-editor",
  rules: {
    "no-flushing-editor-read": noFlushingEditorRead,
  },
  closed: ["no-flushing-editor-read"],
} satisfies LintContribution;
