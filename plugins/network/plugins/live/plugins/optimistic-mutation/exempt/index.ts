import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "live/no-legacy-resource-spelling",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "useOptimisticResource is the live API's one read+write hook — a live read with pending local edits replayed onto it, the sanctioned exception beside useLive (network/live's design rule) — and is compiled onto the old spellings it overlays (useResource over the resolved descriptor).",
  },
] satisfies Exemptions;
