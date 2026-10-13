import type { z } from "zod";
import type { FieldsRecord } from "@plugins/fields/core";
import {
  textField,
  type TextFieldDef,
} from "@plugins/fields/plugins/text/plugins/config/core";
import {
  dateField,
  type DateFieldDef,
} from "@plugins/fields/plugins/date/plugins/config/core";
import { wireSchema } from "@plugins/infra/plugins/entities/core";
import {
  resolveExposure,
  type EntityExposure,
  type ExposesCheck,
  type ExposesDecl,
  type ExposureRow,
} from "./exposure";
import {
  assertNoReservedKeys,
  EXTENSION_TIMESTAMPS,
  type ExtensionTimestamp,
} from "./reserved";

// The complete field record of an extension: the parent key, the plugin's own
// fields, then the two timestamps. `K` is the key's name (`"songId"`), `F` the
// plugin's own fields.
export type ExtensionFields<K extends string, F extends FieldsRecord> = {
  [P in K | keyof F | ExtensionTimestamp]: P extends K
    ? TextFieldDef
    : P extends ExtensionTimestamp
      ? DateFieldDef
      : P extends keyof F
        ? F[P]
        : never;
};

// The keys kept off the wire: the plugin's `serverOnly` fields `S`, plus every
// timestamp the plugin did not put on the wire (`W`).
export type ExtensionServerOnly<
  S extends string,
  W extends ExtensionTimestamp,
> = S | Exclude<ExtensionTimestamp, W>;

// The wire row's zod shape. Spelled exactly like `Entity["schema"]`'s shape
// (`{ [K in Exclude<keyof F, S>]: F[K]["schema"] }`), so a shape's `schema` and
// the entity `defineExtension` builds from it are the same type.
export type ExtensionWireShape<
  K extends string,
  F extends FieldsRecord,
  S extends keyof F & string,
  W extends ExtensionTimestamp,
> = {
  [
    P in Exclude<keyof ExtensionFields<K, F>, ExtensionServerOnly<S, W>>
  ]: ExtensionFields<K, F>[P]["schema"];
};

// What `defineExtensionShape` returns: everything about an extension row that
// the browser needs too. The server half (`defineExtension`) builds the table
// from it; the browser reads `schema` directly.
export interface ExtensionShape<
  K extends string,
  F extends FieldsRecord,
  S extends keyof F & string = never,
  W extends ExtensionTimestamp = never,
  E extends EntityExposure | null = null,
> {
  readonly key: K;
  // The complete record, in column order (see `defineExtensionShape`).
  readonly fields: ExtensionFields<K, F>;
  readonly serverOnly: readonly ExtensionServerOnly<S, W>[];
  readonly schema: z.ZodObject<ExtensionWireShape<K, F, S, W>>;
  // The fields the extension exposes to every list of its parent (or of an
  // entity reaching it) — `null` when it declares no `exposes`. See
  // `./exposure.ts`.
  readonly exposure: E;
}

// The structural bound `defineExtension` takes a shape through. Deliberately
// loose: `ExtensionShape<string, FieldsRecord, …>` would make every field a
// `TextFieldDef` (`P extends string` is true for every key), so a concrete
// shape would not satisfy it.
export interface AnyExtensionShape {
  readonly key: string;
  readonly fields: FieldsRecord;
  readonly serverOnly: readonly string[];
  readonly schema: z.AnyZodObject;
  readonly exposure: EntityExposure | null;
}

export interface ExtensionShapeDef<
  K extends string,
  F extends FieldsRecord,
  S extends keyof F & string,
  W extends ExtensionTimestamp,
> {
  // The parent key's name — the key column's JS property AND the wire field
  // (`"songId"`, `"conversationId"`). Its DB column is always `parent_id`.
  key: K;
  // The plugin's own fields. The key and the timestamps are the primitive's;
  // declaring any of them throws.
  fields: F;
  // Own fields that stay in the table but off the wire (`defineEntity`'s rule).
  serverOnly?: readonly S[];
  // Timestamps to put ON the wire. They are off it by default: they belong to
  // the primitive, and leaving them off keeps a write that changes nothing from
  // sending a row diff just because `updatedAt` moved.
  wireTimestamps?: readonly W[];
  // The own fields every list of the parent shows, filters and groups by —
  // with what a parent with no side row reads (`./exposure.ts`). A server-only
  // field, a timestamp or the key cannot be exposed (tsc).
  exposes?: ExposesDecl;
}

// Declare an extension's row once, in browser-safe code. `defineExtension`
// (server) builds the `<parent>_ext_<name>` table from it, and the browser uses
// `shape.schema` as the row schema — the same object the server's entity
// carries, so the two cannot drift.
export function defineExtensionShape<
  K extends string,
  F extends FieldsRecord,
  S extends keyof F & string = never,
  W extends ExtensionTimestamp = never,
>(
  def: ExtensionShapeDef<K, F, S, W> & { exposes?: undefined },
): ExtensionShape<K, F, S, W>;
// With `exposes`: `X` keeps each `absent` literal (`"main"`), so the exposed
// row's type is the stored value widened by it; `ExposesCheck` rejects a key
// that is not an own wire field and an `options` record that does not name
// exactly the wire values.
export function defineExtensionShape<
  K extends string,
  F extends FieldsRecord,
  const X extends ExposesDecl,
  S extends keyof F & string = never,
  W extends ExtensionTimestamp = never,
>(
  def: ExtensionShapeDef<K, F, S, W> & {
    exposes: X & ExposesCheck<NoInfer<F>, NoInfer<S>, X>;
  },
): ExtensionShape<K, F, S, W, EntityExposure<ExposureRow<F, X>>>;
export function defineExtensionShape<
  K extends string,
  F extends FieldsRecord,
  S extends keyof F & string,
  W extends ExtensionTimestamp,
>(
  def: ExtensionShapeDef<K, F, S, W>,
): ExtensionShape<K, F, S, W, EntityExposure | null> {
  const { key, fields } = def;
  assertNoReservedKeys(key, fields);

  // Key order is load-bearing: drizzle-kit diffs columns positionally, and this
  // is the order every extension table already has (parent_id, the plugin's
  // columns, created_at, updated_at). The cast re-states what the literal holds:
  // a computed `[key]` property widens to an index signature, which TS cannot
  // relate to the per-key conditional of `ExtensionFields`.
  const fullFields = Object.freeze({
    [key]: textField(),
    ...fields,
    createdAt: dateField(),
    updatedAt: dateField(),
  }) as unknown as ExtensionFields<K, F>;

  const onWire = new Set<string>(def.wireTimestamps ?? []);
  const serverOnly: readonly ExtensionServerOnly<S, W>[] = Object.freeze([
    ...(def.serverOnly ?? []),
    ...EXTENSION_TIMESTAMPS.filter(
      (t): t is Exclude<ExtensionTimestamp, W> => !onWire.has(t),
    ),
  ]);

  return Object.freeze({
    key,
    fields: fullFields,
    serverOnly,
    schema: wireSchema(fullFields, serverOnly),
    exposure:
      def.exposes === undefined
        ? null
        : resolveExposure(key, fields, serverOnly, def.exposes),
  });
}
