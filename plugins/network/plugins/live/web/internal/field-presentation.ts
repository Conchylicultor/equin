import type { ReactNode } from "react";
import {
  defineSlot,
  defineSlotFacade,
  type Contribution,
} from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type {
  FieldOptionMeta,
  FieldsRecord,
  InferFieldValue,
} from "@plugins/fields/core";
import type { EntityRef } from "@plugins/infra/plugins/entities/core";
import type { EntityExposure } from "@plugins/infra/plugins/entity-extensions/core";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type {
  ClientFields,
  ClientFieldValue,
  LiveArm,
  LiveFieldIds,
  LiveFields,
  LiveRowsCollection,
  RowKind,
} from "@plugins/network/plugins/live/core";
import { clientFieldsKey } from "./client-fields";

// How a field PRESENTS in every list — the browser half of fields declared
// once (`../../CLAUDE.md`, "Fields"). A field's label, type and options are
// declared once with the field (core); what only the browser can say — its
// cell, its width, a live option set — is registered here, once per OWNER:
//
// - an entity (`EntityRef`) — its own fields, in every list whose rows are it;
// - an exposure (`EntityExposure`) — an extension's exposed fields, in every
//   list whose rows reach its parent entity;
// - a union arm (`LiveArm`) — the arm's fields, in every list of its union;
// - a collection declared by fields (`liveCollection({ fields })`) — its
//   listed fields, in every list of it: the presentation of a collection's own
//   fields (a union's base fields, a mirror's computed ones), declared once
//   beside it instead of by every list. A picked field may be presented by
//   its entity too — the two may not set one property of it. A row kind
//   (`rowKind`) is presented the same way: it is a collection with no server;
// - client fields (`clientFields`) — their fields, in every list of their
//   owner.
//
// The registering plugin may differ from the owner's (a plugin presents a
// field another declares). Data-view folds the registrations a list reaches
// into its derived fields; the list names no owner, the owner names no list.

/**
 * A field's option set: a READ of a live catalog, derived from its read
 * (`mapResource`) — never a stand-in empty list while it loads — or, for a set
 * that is always known (a contribution registry, read synchronously), the
 * options themselves.
 */
export type LiveFieldOptionsRead =
  ResourceResult<readonly LiveFieldOption[]> | readonly LiveFieldOption[];

/** One option of a field read live: its value and how it presents. */
export interface LiveFieldOption extends FieldOptionMeta {
  /** The value's canonical spelling (`fields/core`'s `optionKey`; `"null"` labels the no-value). */
  readonly value: string;
}

/** How one field presents in a list, beyond what its declaration says. */
export interface FieldPresentationSpec<V, Row> {
  /** The cell, from the field's value (and the row); absent ⇒ its type's default cell. */
  cell?: (value: V, row: Row) => ReactNode;
  width?: string;
  align?: "start" | "end" | "center";
  /** `false`: no header text in a table (a glyph column) — the label still names it everywhere else. */
  header?: false;
  /** `false`: a dimension the body leaves out by default (the user can switch it on). */
  visible?: false;
  /**
   * `true`: offered to group by though its type is not grouped by default (a
   * text dimension a person groups by — a release's composition).
   */
  groupable?: true;
  /**
   * The field's options, read live (a model catalog, a tag vocabulary, a
   * contribution registry) — in place of its declared ones. Filtering stays on
   * the raw values.
   */
  useOptions?: Hook<() => LiveFieldOptionsRead>;
}

/** A collection declared by fields — the owner of its own fields' presentation. */
export interface FieldsCollection {
  readonly key: string;
  readonly rowKeys: readonly string[];
  readonly fields: LiveFields;
  readonly from: EntityRef | null;
}

/** What a registration may present: an entity's own fields, an exposure's, an arm's, a collection's. */
export type PresentationOwner =
  | EntityRef
  | EntityExposure
  | LiveArm<unknown, FieldsRecord, string>
  | FieldsCollection
  | ClientFields<unknown, FieldsRecord>;

/** The row a collection (or a row kind) lists. */
type CollectionRow<O> =
  O extends RowKind<infer R>
    ? R
    : O extends LiveRowsCollection<infer R>
      ? R
      : never;

/** The fields an owner declares, by key. */
type OwnerFields<O> =
  O extends EntityRef<string, infer F>
    ? { [K in keyof F & string]: InferFieldValue<F[K]> }
    : O extends EntityExposure<infer R>
      ? R
      : O extends LiveArm<unknown, infer F, string, FieldsRecord>
        ? { [K in keyof F & string]: InferFieldValue<F[K]> }
        : O extends ClientFields<unknown, infer F>
          ? { [K in keyof F & string]: ClientFieldValue<F[K]> }
          : O extends FieldsCollection
            ? {
                [
                  K in LiveFieldIds<O> & keyof CollectionRow<O>
                ]: CollectionRow<O>[K];
              }
            : never;

/**
 * The row a cell is handed: an entity's — its presented field and the
 * registration's declared `reads` (a list carrying fewer throws at mount);
 * an arm's — the union's row; a collection's — its row; an exposure's —
 * nothing beyond its value.
 */
type OwnerRow<O, K extends string, Rd extends string> =
  O extends EntityRef<string, infer F>
    ? {
        readonly [P in (K | Rd) & keyof F]: InferFieldValue<F[P]>;
      }
    : O extends LiveArm<infer Row, FieldsRecord, string, FieldsRecord>
      ? Row
      : O extends ClientFields<infer Row, FieldsRecord>
        ? Row
        : O extends FieldsCollection
          ? CollectionRow<O>
          : unknown;

/** One registration (see {@link FieldPresentation}). */
export interface FieldPresentationRegistration<
  O extends PresentationOwner = PresentationOwner,
  Rd extends string = string,
> {
  owner: O;
  /**
   * An entity owner's OTHER fields its cells read (`["id", "updatedAt"]`) —
   * every list applying the registration must carry them (asserted at mount).
   * A collection's cells read its whole row.
   */
  reads?: O extends FieldsCollection ? never : readonly Rd[];
  fields?: {
    readonly [K in keyof OwnerFields<O> & string]?: FieldPresentationSpec<
      OwnerFields<O>[K],
      OwnerRow<O, K, Rd>
    >;
  };
}

/** A registration as the slot stores it (its types erased). */
export interface StoredFieldPresentation {
  readonly owner: PresentationOwner;
  readonly reads: readonly string[];
  readonly fields: Readonly<
    Record<string, FieldPresentationSpec<unknown, unknown>>
  >;
}

/** The key a collection's own presentation is registered under (`presentationOwnerKey` of it). */
export function collectionPresentationKey(collectionKey: string): string {
  return `collection:${collectionKey}`;
}

/** The key one owner's registrations are matched by — the same for its fields' readers. */
export function presentationOwnerKey(owner: PresentationOwner): string {
  if ("rowKeys" in owner) return collectionPresentationKey(owner.key);
  switch (owner.kind) {
    case "entity":
      return `entity:${owner.name}`;
    case "exposure":
      return `exposure:${owner.slice}`;
    case "live-columns":
      return `arm:${owner.owner.collection}:${owner.owner.arm}`;
    case "client-fields":
      return clientFieldsKey(owner);
    default:
      return owner satisfies never;
  }
}

const PresentationSlot = defineSlot<StoredFieldPresentation>({
  docLabel: (r) => presentationOwnerKey(r.owner),
});

/**
 * The one erasure: `O` and `Rd` tie each cell to its owner's values and rows,
 * so they must survive to the call site — the slot stores the erased one.
 */
function register<
  const O extends PresentationOwner,
  const Rd extends string = never,
>(registration: FieldPresentationRegistration<O, Rd>): Contribution {
  return PresentationSlot({
    owner: registration.owner,
    reads: registration.reads ?? [],
    fields: (registration.fields ?? {}) as StoredFieldPresentation["fields"],
  });
}

/**
 * `FieldPresentation.Register({ owner, reads?, fields? })` — present an
 * owner's fields in every list that reaches it (a collection: its own
 * fields, in every list of it). An extension's web barrel
 * registers its exposure, a union arm's its arm, even with nothing to present
 * (`live:presentations-registered` checks each exposure and arm is).
 */
export const FieldPresentation = {
  Register: defineSlotFacade(register, PresentationSlot),
};

/** Every registered presentation (data-view folds those a list reaches). */
export function useFieldPresentations(): readonly StoredFieldPresentation[] {
  return PresentationSlot.useContributions();
}
