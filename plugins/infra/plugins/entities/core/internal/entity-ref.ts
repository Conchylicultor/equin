import type { FieldsRecord } from "@plugins/fields/core";

// A reference to an entity by its table name, carrying its browser-safe field
// record — what a declaration names an entity WITH when it must not import the
// entity itself: browser-safe code (a `liveCollection`'s `exposes`, an
// extension shape's `exposes.parent`) cannot reach the server-only
// `defineEntity`. The name IS the entity's table name; the server half builds
// the table FROM the ref (`defineEntity(ref, meta)`), so the record a browser
// list reads and the table a server reads are one declaration. The other
// server halves assert the name against the table they are handed
// (`defineExtension`, a collection's bind), so a ref naming a table nobody
// defined fails loudly there, never silently matches nothing.
//
// `presentationReads` are the OTHER fields the entity's presentation reads
// beside the one it presents (a status cell reading the row's id and
// timestamps — `FieldPresentation.Register({ owner: ref })`, network/live/web).
// Declared here, once, so every `liveCollection({ from: ref })` carries them
// by construction: no collection can list the entity without them.
export interface EntityRef<
  N extends string = string,
  F extends FieldsRecord = FieldsRecord,
  R extends keyof F & string = keyof F & string,
> {
  readonly kind: "entity";
  readonly name: N;
  /** The entity's field record, in column order — `defineEntity(ref)` builds its table from it. */
  readonly fields: F;
  /** The fields its presentation reads beside the presented one — on every collection's row `from` it. */
  readonly presentationReads: readonly R[];
}

/**
 * The fields an entity ref's presentation reads (`never` for none, and for a
 * widened ref whose reads are any `string` — not known statically).
 */
export type PresentationReadsOf<E> =
  E extends EntityRef<string, FieldsRecord, infer R>
    ? string extends R
      ? never
      : R
    : never;

/**
 * A ref to the entity whose table is `name`, its fields `fields`
 * (`entityRef("tasks", taskFields)`), and the fields its presentation reads
 * beside the presented one (`{ presentationReads: ["id", "updatedAt"] }`).
 */
export function entityRef<
  const N extends string,
  F extends FieldsRecord,
  const R extends keyof F & string = never,
>(
  name: N,
  fields: F,
  options?: { presentationReads?: readonly R[] },
): EntityRef<N, F, R> {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(
      `entityRef("${name}"): an entity is named by its table name (lower snake case).`,
    );
  }
  const presentationReads = options?.presentationReads ?? [];
  for (const read of presentationReads) {
    if (!Object.hasOwn(fields, read)) {
      throw new Error(
        `entityRef("${name}"): presentationReads names "${read}", which is not one of its fields.`,
      );
    }
  }
  return Object.freeze({
    kind: "entity",
    name,
    fields,
    presentationReads: Object.freeze([...new Set(presentationReads)]),
  });
}
