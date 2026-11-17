import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// App exhibits: the fix reads the live sign-in flow and the endpoints' machine.
export default [
  appExhibit({
    id: "claude-sign-in/claude-code-fix",
    label:
      "Claude Code block with its fix (signed out, sign-in refused, button)",
    widths: [420, 760],
    load: () => import("./internal/claude-code-fix"),
  }),
];
