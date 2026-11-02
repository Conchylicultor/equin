import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { compileFromTable, deriveUpdatedAt } from "./internal/from-table";
export {
  registerDerivedUpdatedAt,
  registeredDerivedUpdatedAt,
} from "./internal/registry";
export { installDerivedUpdatedAt } from "./internal/install";
export type { TouchRule, DerivedUpdatedAtSpec } from "./internal/types";
export type { TableTouchedBy, TableWithUpdatedAt } from "./internal/from-table";

export default {
  description:
    "Derived updatedAt: compiles a table's per-column touchedBy rules (declared in defineEntity's meta.updatedAt, or deriveUpdatedAt on a raw pgTable) into a BEFORE UPDATE trigger that sets updated_at = now() only when a counted column really changed and RAISEs on any app write to it; a registry filled at module eval, the boot installer (signature-in-COMMENT, advisory-locked, asserted) the database plugin runs right after migrations, and a check that every schema table with an updated_at column declares one.",
} satisfies ServerPluginDefinition;
