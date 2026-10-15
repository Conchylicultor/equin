import type { ComponentType, ReactNode } from "react";
import {
  defineSlot,
  defineSlotFacade,
  type Contribution,
} from "@plugins/framework/plugins/web-sdk/core";
import type { FieldsRecord } from "@plugins/fields/core";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type {
  ClientFields as ClientFieldsDecl,
  ClientFieldValue,
} from "@plugins/network/plugins/live/core";

// The web half of client fields (`../../core/internal/row-kind.ts`): the
// declaring plugin's web barrel resolves its fields' values, once, and every
// list of the owner gets them (data-view folds the resolvers a list reaches).
// A resolver is a COMPONENT, not a hook: it is handed the list's rows and may
// read per row (a probe per deployment) as well as once per surface.

/** Each field's value per row, as a resolver hands them back. */
export type ClientFieldReaders<Row, F extends FieldsRecord> = {
  readonly [K in keyof F & string]: (row: Row) => ClientFieldValue<F[K]>;
};

/**
 * What a resolver renders through: its values as a READ — `loading` (every
 * cell draws the loading block, a view laid out by a field its loading state),
 * `error` (the failure with Retry; with `stale` readers it keeps painting
 * them) or `ready` — never a stand-in value while it loads.
 */
export type ClientFieldValues<Row, F extends FieldsRecord> = ResourceResult<
  ClientFieldReaders<Row, F>
>;

/** The props a resolver component receives. */
export interface ClientFieldsResolverProps<Row, F extends FieldsRecord> {
  /** The list's rows — every row it holds, in no particular order. */
  readonly rows: readonly Row[];
  readonly render: (values: ClientFieldValues<Row, F>) => ReactNode;
}

/** One registration: a declaration and the component resolving its values. */
export interface ClientFieldsResolution<Row, F extends FieldsRecord> {
  fields: ClientFieldsDecl<Row, F>;
  component: ComponentType<ClientFieldsResolverProps<Row, F>>;
}

/**
 * A registration as the slot stores it (its types erased). Its component is
 * sealed by the slot: only `renderClientFieldsResolver` mounts it.
 */
export interface StoredClientFieldsResolution {
  readonly fields: ClientFieldsDecl<unknown, FieldsRecord>;
  readonly component: unknown;
}

/** The key a declaration's resolver (and its presentation) is registered under. */
export function clientFieldsKey(
  decl: Pick<ClientFieldsDecl<unknown>, "owner" | "id">,
): string {
  return `client:${decl.owner}:${decl.id}`;
}

const ResolverSlot = defineSlot<StoredClientFieldsResolution>({
  docLabel: (r) => clientFieldsKey(r.fields),
});

/** The one erasure: `Row` and `F` tie the resolver to its declaration. */
function resolve<Row, F extends FieldsRecord>(
  registration: ClientFieldsResolution<Row, F>,
): Contribution {
  return ResolverSlot(registration as unknown as StoredClientFieldsResolution);
}

/**
 * `ClientFields.Resolve({ fields, component })` — resolve a `clientFields`
 * declaration's values in every list of its owner. Exactly one per
 * declaration, from the declaring plugin's web barrel (the
 * `live:client-fields-resolved` check).
 */
export const ClientFields = {
  Resolve: defineSlotFacade(resolve, ResolverSlot),
};

/** Every registered resolver (data-view folds those a list's owner has). */
export function useClientFieldsResolvers(): readonly StoredClientFieldsResolution[] {
  return ResolverSlot.useContributions();
}

/**
 * Mount one resolver for a list: its component (unsealed, inside the slot's
 * error-boundary item middleware, so a broken resolver is caught and named)
 * handed the list's rows and the `render` the list continues through.
 */
export function renderClientFieldsResolver(
  resolution: StoredClientFieldsResolution,
  props: ClientFieldsResolverProps<unknown, FieldsRecord>,
): ReactNode {
  return renderIsolated(
    ResolverSlot,
    resolution as unknown as Contribution,
    props,
  );
}
