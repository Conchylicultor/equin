import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "live/no-legacy-resource-spelling",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "useOptimisticResource is the live API's one read+write hook — a live read with pending local edits replayed onto it, the sanctioned exception beside useLive (network/live's design rule) — and is compiled onto the old spellings it overlays (useResource over the resolved descriptor).",
  },
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/internal/use-optimistic-resource.ts"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — useOptimisticCore (reads a ref during render).",
  },
] satisfies Exemptions;
