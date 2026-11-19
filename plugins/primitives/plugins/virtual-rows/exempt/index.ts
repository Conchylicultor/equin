import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/internal/virtual-rows.tsx"],
    kind: "sanctioned",
    reason:
      "The compiler refuses @tanstack/react-virtual's useVirtualizer (its returned functions are mutable, so memoizing them would serve stale rows); the windowing hook stays uncompiled by design and the rows it renders are compiled components.",
  },
] satisfies Exemptions;
