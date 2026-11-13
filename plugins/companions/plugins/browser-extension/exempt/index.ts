import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "frame/no-raw-frame",
    paths: ["browser-extension/popup.ts"],
    kind: "sanctioned",
    reason:
      "The extension's own popup, at its chrome-extension:// origin, framing the equin page it is the shell of — no React and no app origin here for the framing primitive to guard; the page accepts the bridge only from this extension's origin.",
  },
] satisfies Exemptions;
