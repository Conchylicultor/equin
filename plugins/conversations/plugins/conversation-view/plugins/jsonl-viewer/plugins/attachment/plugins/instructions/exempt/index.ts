import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "paths:no-hardcoded-paths",
    paths: ["web/__tests__/instructions-view.test.tsx"],
    kind: "sanctioned",
    reason:
      "A made-up payload path under a made-up home, echoed by the card under test — fixture data, not a location anything resolves. The real HOME_DIR comes from Node-only paths/data-root-layout, which a jsdom suite cannot load.",
  },
] satisfies Exemptions;
