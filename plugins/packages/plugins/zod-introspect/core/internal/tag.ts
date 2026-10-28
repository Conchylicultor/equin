import { isV4Schema, v4TagDef, v4WithTag } from "./backend-v4";

/**
 * A namespaced tag a plugin puts on a schema, riding the schema object itself
 * (its def) rather than a side map or a zod registry: a registry is per module
 * instance (web artifacts may each bundle their own zod), and zod's registry
 * follows no wrapper — `.optional()` / `.nullable()` / `.default()`.
 */
export interface SchemaTag<T> {
  readonly name: string;
  /**
   * A NEW schema like `schema`, tagged `value` — never the source mutated
   * (zod 4's `.describe()` / `.meta()` share their def with the source, so a
   * mutation would tag both). The tag survives every clone zod makes of it
   * (`.max()`, `.min()`, `.describe()`, `.meta()`, `.check()`, `.refine()`,
   * `.brand()`), and a wrapper (`.optional()`, …) holds it on its inner
   * schema, reached by walking the wrapper's node. Throws on a non-schema.
   */
  set<S extends object>(schema: S, value: T): S;
  /**
   * The tag on `schema` itself (a brand or refinement wraps nothing), else
   * undefined. A wrapper's tag is its inner
   * schema's: read `get(node.inner)`. Throws on a non-schema.
   */
  get(schema: unknown): T | undefined;
}

/**
 * A tag named `name` (`"list-bound"`). The value is stored as given and read
 * back unchecked — the tag's owner validates what it reads.
 */
export function defineSchemaTag<T>(name: string): SchemaTag<T> {
  if (name === "") throw new Error("defineSchemaTag: an empty tag name.");
  const key = `~equin.tag.${name}`;
  return {
    name,
    set<S extends object>(schema: S, value: T): S {
      if (isV4Schema(schema)) return v4WithTag(schema, key, value) as S;
      throw new TypeError(
        `defineSchemaTag("${name}").set: not a zod schema (${typeof schema}).`,
      );
    },
    get(schema: unknown): T | undefined {
      if (isV4Schema(schema)) return v4TagDef(schema)[key] as T | undefined;
      throw new TypeError(
        `defineSchemaTag("${name}").get: not a zod schema (${typeof schema}).`,
      );
    },
  };
}
