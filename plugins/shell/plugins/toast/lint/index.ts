import noDirectCustomToast from "./no-direct-custom-toast";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for the toast stack: every toast goes through `useToast`
 * (`shell/notifications`), which records it in the notification history.
 */
export default {
  name: "shell-toast",
  rules: {
    "no-direct-custom-toast": noDirectCustomToast,
  },
} satisfies LintContribution;
