import { defineIdKind, type IdOf } from "@plugins/ids/core";

/**
 * One before / after pair (`before_after_pairs.id`), declared once
 * (`plugins/ids`). Stamped (`ba-<epoch>-<6>`): an agent cites it in its text,
 * where it renders as a chip (`active-data/before-after`).
 */
export const baIdKind = defineIdKind({ prefix: "ba", label: "Before / after" });

export type BaId = IdOf<typeof baIdKind>;
