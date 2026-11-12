import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";
import ts from "typescript";
import { factsOf, type ModulePortabilityFacts } from "./portability-facts";

// The portability facts as the per-file scan the build keeps as file records
// (`portability.ts`). Its records are keyed by this module's whole closure and
// the npm code it imports, so it imports `typescript` itself rather than take
// it from its caller (a parser handed in would run unkeyed). `portability.ts`
// loads it lazily, so only a pass that measures portability pays `typescript`.

/** Each module's {@link ModulePortabilityFacts} as a file scan. */
export const PORTABILITY_FACTS_SCAN: FileScan<ModulePortabilityFacts> = {
  url: import.meta.url,
  scan: (src, rel) => factsOf(ts, rel, src),
};
