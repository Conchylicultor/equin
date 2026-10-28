import { z } from "zod";
import {
  fieldSchemaWithDefault,
  type DefaultedFields,
  type FieldDef,
  type FieldMeta,
  type FieldsRecord,
  type FieldType,
  type InferFieldsObject,
} from "@plugins/fields/core";
import {
  listFieldType,
  type ListItem,
} from "@plugins/fields/plugins/list/core";

export interface ListFieldDef<
  F extends FieldsRecord = FieldsRecord,
> extends FieldDef<ListItem<F>[]> {
  readonly itemFields: F;
  readonly stableIdentity: boolean;
}

export function isListFieldDef(field: FieldDef): field is ListFieldDef {
  return "itemFields" in field;
}

function pickMeta(opts?: FieldMeta): FieldMeta {
  return {
    label: opts?.label,
    description: opts?.description,
    placeholder: opts?.placeholder,
  };
}

export function listField<const F extends FieldsRecord>(
  opts: FieldMeta & {
    // A new item (the list's Add) is seeded from its fields' defaults: each
    // needs one (tsc).
    itemFields: F & DefaultedFields<F>;
    // Seeded defaults may carry the list item's stable `id` (optional, exactly
    // as the stored schema permits) so a code-authored default row is editable
    // without waiting for a UI "Add". Order is array position — no `rank`.
    default?: Array<InferFieldsObject<F> & { id?: string }>;
    // Opt in when this list's item ids are used as DURABLE EXTERNAL KEYS (e.g. a
    // saved row order keyed by view id): each row must then carry an explicit,
    // content-independent `id` persisted in the config file — enforced by the
    // `config-stable-list-ids` check. Absent the flag, a row authored without an
    // `id` gets a content+index-derived seed that changes when the row's content
    // or position changes (fine for render-only lists, unsafe for durable keys).
    stableIdentity?: boolean;
  },
): ListFieldDef<F> {
  const subShape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(opts.itemFields)) {
    // A missing item key (e.g. a field added after items were stored) heals to
    // the field's default instead of failing the whole list's validation.
    subShape[key] = fieldSchemaWithDefault(field);
  }

  const itemSchema = z
    .object({
      id: z.string().optional(),
      // Legacy-read tolerance only: array position is the canonical order now, so
      // no `rank` is ever written, but a document stored before that change may
      // still carry one on disk. Keep it optional so it parses cleanly (the
      // registry's normalizeCollectionItems migrates then drops it).
      rank: z.string().optional(),
      ...subShape,
    })
    .passthrough();

  const schema = z.array(itemSchema);

  return Object.freeze({
    type: listFieldType as FieldType<ListItem<F>[]>,
    // `id` is `.optional()` on the wire (legacy documents predate it) but
    // required on `ListItem`, so the output types genuinely differ — a cast the
    // input widening does not remove.
    schema: schema as unknown as z.ZodType<ListItem<F>[]>,
    defaultValue: (opts.default ?? []) as ListItem<F>[],
    meta: pickMeta(opts),
    itemFields: opts.itemFields,
    stableIdentity: opts.stableIdentity ?? false,
  });
}
