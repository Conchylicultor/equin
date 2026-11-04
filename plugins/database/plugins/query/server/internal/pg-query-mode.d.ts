// pg ≥ 8.11 reads `queryMode` (lib/query.js `requiresPreparation`), but
// @types/pg does not declare it yet. `oneStatement` (./one-statement.ts) sends
// caller-written SQL with `queryMode: "extended"`.
//
// A declaration-only file: an augmentation is seen by every file without being
// imported, so in a source file every edit to it would re-check the whole repo
// (`type-check/no-global-declaration-in-source`).
import type {} from "pg";

declare module "pg" {
  interface QueryConfig {
    queryMode?: "simple" | "extended";
  }
}
