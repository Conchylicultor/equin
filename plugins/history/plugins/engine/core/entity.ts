import { z } from "zod";
import type { FieldsRecord } from "@plugins/fields/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { versionIdKind } from "./id-kind";
import { VERSION_CARRIED, VERSION_LISTED } from "./schemas";

/**
 * A stored version's fields — the `entity_versions` table is built from them
 * (`server/internal/tables.ts`): the metadata a timeline lists, plus the
 * opaque per-source `snapshot`. The engine hands the snapshot back to that
 * source's own `restore(entityId, snapshot: unknown)` and never looks inside,
 * so `unknown` is its true type and the column carries no decoder — narrowing
 * it would have to happen per source, which is where the shape is known. No
 * list picks it.
 */
export const versionFields = {
  ...VERSION_CARRIED,
  id: idKindField(versionIdKind),
  ...VERSION_LISTED,
  snapshot: jsonField<unknown>({ schema: z.unknown(), default: null }),
} satisfies FieldsRecord;

/** The `entity_versions` entity — every stored version, of every source. */
export const entityVersionsEntityRef = entityRef(
  "entity_versions",
  versionFields,
);
