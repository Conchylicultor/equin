import type { ColumnConfigDerive } from "@plugins/primitives/plugins/data-view/web";
import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/core";

/**
 * One stored option of an enum custom column — the same shape the generic
 * `FieldDef.options` publishes, so `deriveEnumFieldDef` can forward it whole.
 *
 * `variant`/`hint` are carried but NOT authored here: `EnumOptionsEditor` gives
 * the user no colour picker, so a user-defined column's values stay muted —
 * the right default for values with no semantics. They are in the type because
 * the config blob is persisted unvalidated and round-trips opaquely, so a
 * future author-time colour is a pure editor change.
 */
export interface EnumOption {
  value: string;
  label: string;
  variant?: BadgeVariant;
  hint?: string;
}

/**
 * Narrow the opaque config blob to the `{ options }` shape enum understands.
 * This module is the ONLY place in the repo that may read it — the editor writes
 * it and `deriveEnumFieldDef` publishes it as a generic `FieldDef.options`.
 */
export function readOptions(config: unknown): EnumOption[] {
  return (config as { options?: EnumOption[] } | undefined)?.options ?? [];
}

/**
 * The enum type's custom-column projection: its private `config.options` becomes
 * the generic `FieldDef.options` every data-view consumer already reads (chip
 * cell, inline editor, filter input, group-by section label). Without it those
 * consumers see only the stored value — a minted option id, not the label.
 */
export const deriveEnumFieldDef: ColumnConfigDerive = (config) => ({
  options: readOptions(config),
});
