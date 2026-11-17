import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "scroll-safety/no-scrolling-focus",
    paths: ["standalone-page/main.ts"],
    kind: "sanctioned",
    reason:
      "The installer window's page is bundled into a native binary and may import `core` only (its folder's boundary row), so it cannot reach focusElement. Its one focus (the password sheet's field, just opened for the person) passes preventScroll itself, in a page that does not scroll.",
  },
  {
    rule: "paths:no-hardcoded-paths",
    paths: ["e2e/moment.ts"],
    kind: "sanctioned",
    reason:
      "The approved mockup's failure evidence, ported verbatim so the page draws the same lines as the mockup it is compared against: text on screen, never a path anything resolves.",
  },
] satisfies Exemptions;
