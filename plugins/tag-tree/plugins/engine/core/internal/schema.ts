import { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import { anyTagTreeBaseFields } from "./fields";

// The base row every tree's rows share, as a wire schema: derived from the
// base field record, its id any stored string (a tree's extras are stripped —
// `z.object` drops unknown keys).

/** A tag of any tree, its base fields only (extras stripped). */
export const TagRowSchema = fieldsToZodObject(anyTagTreeBaseFields());

/**
 * A tag row: the base fields every tree has. A tree's own rows extend it with
 * its extras (`TagTree<Row extends TagRow>`). `rank` is the raw fractional key
 * (`Rank.from` wraps it), which sorts by plain string compare.
 */
export type TagRow = z.infer<typeof TagRowSchema>;

/** A tag colour: `#rrggbb`. */
export const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "a colour is #rrggbb");
