import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-raw-websocket",
    paths: ["e2e/clean-soak.ts"],
    kind: "sanctioned",
    reason:
      "A measurement script run under bun, not a browser tab: it speaks the Chrome DevTools Protocol to a Chromium it spawned itself, on the browser target only, precisely so that nothing (no Playwright, no app transport) is attached to the page it measures.",
  },
] satisfies Exemptions;
