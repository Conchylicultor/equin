import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { compileFromTable, deriveUpdatedAt } from "./internal/from-table";
export {
  registerDerivedUpdatedAt,
  registeredDerivedUpdatedAt,
} from "./internal/registry";
export type { TouchRule, DerivedUpdatedAtSpec } from "./internal/types";
export type { TableTouchedBy, TableWithUpdatedAt } from "./internal/from-table";

export default {
  description:
    "Derived updatedAt: compiles a table's per-column touchedBy rules (declared in defineEntity's meta.updatedAt, or deriveUpdatedAt on a raw pgTable) into a BEFORE UPDATE trigger that sets updated_at = now() only when a counted column really changed and RAISEs on any app write to it; each compiled to a db-triggers set (updated-at.<table>) the boot schema layer installs with every other declared trigger set; a registry filled at module eval, and a check that every schema table with an updated_at column declares one.",
} satisfies ServerPluginDefinition;
