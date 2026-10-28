import { z } from "zod";
import { type FieldDef, type FieldMeta, pickMeta } from "@plugins/fields/core";
import {
  avatarFieldType,
  type AvatarSpec,
} from "@plugins/fields/plugins/avatar/core";
import { SavedSymbolNameSchema } from "@plugins/ui/plugins/icons/plugins/saved-names/core";

// A stored avatar: `icon` is a Material Symbols name the installed sets draw.
// A saved config still holding a classic key (`star_outline`) is migrated at
// build time (the owning config's `migrations`), never decoded here — a classic
// key fails this parse.
const avatarSpecSchema: z.ZodType<AvatarSpec> = z.object({
  icon: SavedSymbolNameSchema.nullable(),
  color: z.string().nullable(),
});

export interface AvatarFieldDef extends FieldDef<AvatarSpec> {
  readonly type: typeof avatarFieldType;
}

export function avatarField(
  opts?: FieldMeta & { default?: AvatarSpec },
): AvatarFieldDef {
  return Object.freeze({
    type: avatarFieldType,
    schema: avatarSpecSchema,
    defaultValue: opts?.default ?? { icon: null, color: null },
    meta: pickMeta(opts),
  });
}
