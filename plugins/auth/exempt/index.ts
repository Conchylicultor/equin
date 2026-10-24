import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "timer/no-unlisted-timer",
    paths: ["central/internal/refresh-loop.ts"],
    kind: "sanctioned",
    reason:
      "The central runtime has no job queue, so its one periodic task (refresh OAuth tokens before they expire) can only be a timer.",
  },
  {
    rule: "namespace:legacy-host",
    paths: ["central/internal/oauth-flow.test.ts"],
    kind: "sanctioned",
    reason:
      "Pins that a Connect started from main's old address posts its result back there, not to the address main is handed out under.",
  },
] satisfies Exemptions;
