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
export interface EntityRef<
  N extends string = string,
  F extends FieldsRecord = FieldsRecord,
> {
  readonly kind: "entity";
  readonly name: N;
  /** The entity's field record, in column order — `defineEntity(ref)` builds its table from it. */
  readonly fields: F;
}

/** A ref to the entity whose table is `name`, its fields `fields` (`entityRef("tasks", taskFields)`). */
export function entityRef<const N extends string, F extends FieldsRecord>(
  name: N,
  fields: F,
): EntityRef<N, F> {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(
      `entityRef("${name}"): an entity is named by its table name (lower snake case).`,
    );
  }
  return Object.freeze({ kind: "entity", name, fields });
}
