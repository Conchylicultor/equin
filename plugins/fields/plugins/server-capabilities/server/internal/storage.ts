import {
  defineServerContribution,
  type ServerContribution,
  type ServerContributionToken,
} from "@plugins/framework/plugins/server-core/core";
import type { ColumnBuilderBaseConfig, ColumnDataType } from "drizzle-orm";
import type { PgColumnBuilderBase } from "drizzle-orm/pg-core";
import type { FieldType } from "@plugins/fields/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";

/** A column builder whose drizzle `data` type is exactly `V` — i.e. the column
 *  really hands back a `V`, rather than being asserted to. This is what pins a
 *  builder's return type to the value type its token declares: a `date` token
 *  handing back a `boolean()` column stops compiling. */
export type StorageColumnFor<V> = PgColumnBuilderBase<
  ColumnBuilderBaseConfig<ColumnDataType, string> & { data: V }
>;

/** Builds the BARE column for a field's value. Modifiers (notNull, default,
 *  primaryKey) are applied by the entity builder (Stage C) from the field spec
 *  + entity meta — never baked in here. */
export type StorageColumnBuilder<B = unknown> = (
  name: string,
) => StorageColumnFor<B>;

/**
 * How one field type becomes a DB column — and, in its own type, whether that
 * column holds exactly what the type declares or is narrowed by the FIELD's own
 * schema.
 *
 * The two arms are two different promises, and which one a type makes is
 * precisely the fact a single `(name) => PgColumnBuilderBase` signature loses:
 * it never sees the schema, so it *cannot* decode, and its return type says
 * nothing, so any column at all typechecks. See
 * `research/2026-08-25-global-decoded-entity-columns.md`.
 */
export type FieldStorageContribution<B = unknown> = { type: FieldType<B> } & (
  | {
      /** This type's column holds exactly `B`; no field can narrow it. */
      build: StorageColumnBuilder<B>;
      decode?: never;
    }
  | {
      /** This type's column is narrowed by the FIELD's own schema, so that
       *  schema is what must run for the narrowing to be true. `V` is inferred
       *  from the schema argument and from nowhere else, so the declared type
       *  cannot be chosen independently of what decodes. */
      decode: <V extends B>(
        name: string,
        valueSchema: ZodParser<V>,
      ) => StorageColumnFor<V>;
      build?: never;
    }
);

// Eager, additive index of every field-storage contribution, populated the
// instant a `Fields.Storage(...)` contribution is DECLARED (barrel module-eval)
// — by the token's own `project`, below. It is a fallback consulted AFTER the
// live registry, so it stays available in the windows where
// `collectContributions` has not run yet: the drizzle-kit codegen subprocess
// (never boots) and the boot loader pass (evals `tables.ts` before
// `collectContributions`). The capability barrels are pulled in eagerly by the
// `fields/server-capabilities-loader` plugin's `eager.generated` manifest, which
// every eval-time consumer of `resolveField*` imports for side-effect — so every
// contribution self-registers here before any `defineEntity` body runs, with NO
// filesystem scan (a `readdirSync` of the source tree resolves to a nonexistent
// `/plugins` inside a `bun --compile` release binary). This library plugin is a
// graph SINK: it never imports a capability barrel, so no import cycle can form
// through it.
const eager = new Map<string, FieldStorageContribution>();

// DECLARING a contribution records it in the eager index through the token's
// `project` — the token call itself never touches the live registry (that only
// happens in `collectContributions` at boot), so this is the sole mechanism that
// makes contributions resolvable in the pre-collect eval window. The token is
// never wrapped: every read (`getContributions`, `getContributionsIfCollected`,
// `from`) is the token's own.
const storageToken = defineServerContribution<
  FieldStorageContribution,
  FieldStorageContribution
>("fields.storage", {
  docLabel: (p) => p.type.id,
  project: (props) => {
    eager.set(props.type.id, props);
    return props;
  },
});

type StorageTokenReads = ServerContributionToken<FieldStorageContribution>;

/** The `Fields.Storage` token: every read of the underlying token, with its call
 *  made generic in `B` so the value type is inferred from the `type` token and
 *  both arms are checked against it. The reads are `Pick`ed (a mapped type
 *  drops the token's own `(input: FieldStorageContribution)` call), so the
 *  generic call is the ONLY call — a non-generic fallback overload would accept
 *  a mismatched contribution the generic one rejects. */
export interface FieldStorageToken extends Pick<
  StorageTokenReads,
  keyof StorageTokenReads
> {
  <B>(props: FieldStorageContribution<B>): ServerContribution;
}

// Narrows only the call: `B` is erased at runtime, so the token already takes
// any `FieldStorageContribution<B>`. The reads are the token's own, typed from
// its own `ServerContributionToken` — nothing here re-attaches them by hand.
const StorageToken = storageToken as FieldStorageToken;

export const Fields = {
  /** Per-type DB column. Contribute `{ type, build }` for a type whose column
   *  holds exactly its declared value, or `{ type, decode }` for one whose
   *  column is narrowed by the field's own schema; keyed by type token. */
  Storage: StorageToken,
};

/** Resolve a field type's storage CONTRIBUTION by exact token (no `extends`
 *  fallback). The whole contribution, not a builder, because the caller must
 *  pick an arm — and only the caller (`defineEntity`) holds the field schema the
 *  `decode` arm needs. Live-first so a test that registers a throwaway type via
 *  `collectContributions` still wins; falls back to the eager self-registered
 *  index for codegen / boot windows. */
export function resolveFieldStorage(
  typeId: string,
): FieldStorageContribution | undefined {
  const live = Fields.Storage.getContributionsIfCollected()?.find(
    (c) => c.type.id === typeId,
  );
  return live ?? eager.get(typeId);
}
