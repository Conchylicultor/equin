// A reference to an entity by its table name — what a declaration names an
// entity WITH when it must not import the entity itself: browser-safe code (a
// `liveCollection`'s `exposes`, an extension shape's `exposes.parent`) cannot
// reach the server-only `defineEntity`. The name IS the entity's table name;
// the server halves assert it against the table they are handed
// (`defineExtension`, a collection's bind), so a ref naming a table nobody
// defined fails loudly there, never silently matches nothing.
export interface EntityRef<N extends string = string> {
  readonly kind: "entity";
  readonly name: N;
}

/** A ref to the entity whose table is `name` (`entityRef("tasks")`). */
export function entityRef<const N extends string>(name: N): EntityRef<N> {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(
      `entityRef("${name}"): an entity is named by its table name (lower snake case).`,
    );
  }
  return Object.freeze({ kind: "entity", name });
}
