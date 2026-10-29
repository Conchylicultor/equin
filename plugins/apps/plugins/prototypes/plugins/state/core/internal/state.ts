import { z } from "zod";
import { idKindField } from "@plugins/ids/core";
import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  liveCollection,
  patchRow,
  upsertRow,
} from "@plugins/network/plugins/live/core";
import { protoIdKind } from "@plugins/apps/plugins/prototypes/plugins/files/core";

// A prototype's state — what the user said about it, as opposed to what it is:
// pinned (sorted first in its gallery section), Done, its one tag, and whether
// it is deleted. A delete is a field here, not a move of the folder: a deleted
// prototype stays a prototype — its folder, history and picks stay where they
// are, every link to it keeps resolving, and the gallery lists it in its Trash
// until restored. The prototype
// FOLDERS are host-global (shared by main and every worktree); this state is a
// row in the instance's own DB, so a worktree changes it in its DB fork without
// touching main's. A prototype with no row has `NO_PROTOTYPE_STATE`.

export const prototypeStateFields = {
  /** The prototype folder's id. Hand-made folders with another name have no state. */
  id: idKindField(protoIdKind),
  pinned: boolField({ label: "Pinned" }),
  done: boolField({ label: "Done" }),
  /** One tag of `prototypeTagTree`, or none. */
  tagId: nullable(textField({ label: "Tag" })),
  /** When the user deleted it — `null` while it is not deleted. */
  deletedAt: nullable(dateField({ label: "Deleted" })),
  createdAt: dateField(),
  updatedAt: dateField(),
};

export const prototypeStateEntityRef = entityRef(
  "prototype_state",
  prototypeStateFields,
);

/**
 * Every prototype's recorded state, live — the whole set, read whole: the
 * gallery joins it onto the whole prototype list it already holds.
 */
export const prototypeStates = liveCollection("prototypes.state.all", {
  from: prototypeStateEntityRef,
  carry: {
    pick: [
      "id",
      "pinned",
      "done",
      "tagId",
      "deletedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  id: "id",
  all: {
    orderBy: [["id", "asc"]],
    unbounded: {
      reason:
        "one row per prototype the user marked; the gallery joins it onto the whole list it already holds",
    },
  },
});

/** What the user said about one prototype. */
export interface PrototypeState {
  readonly pinned: boolean;
  readonly done: boolean;
  readonly tagId: string | null;
  /** When the user deleted it — `null` while it is not deleted. */
  readonly deletedAt: Date | null;
}

/** The state of a prototype with no row: neither pinned nor Done, untagged, not deleted. */
export const NO_PROTOTYPE_STATE: PrototypeState = Object.freeze({
  pinned: false,
  done: false,
  tagId: null,
  deletedAt: null,
});

/** A prototype's state as the server's first write to it creates it: the column defaults. */
function newStateRow(name: string) {
  const now = new Date();
  return {
    id: protoIdKind.parse(name),
    ...NO_PROTOTYPE_STATE,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * One change to a prototype's state: the fields it sets, never the whole
 * record, so ticking Done cannot clobber a pin or a tag set elsewhere.
 * `deletedAt` is never in it — only the delete and restore endpoints write it,
 * the server stamping the instant.
 */
export const PrototypeStateChangeSchema = z
  .object({
    done: z.boolean().optional(),
    pinned: z.boolean().optional(),
    tagId: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine(
    (c) =>
      c.done !== undefined || c.pinned !== undefined || c.tagId !== undefined,
    { message: "a state change sets `done`, `pinned`, `tagId`, or several" },
  );
export type PrototypeStateChange = z.infer<typeof PrototypeStateChangeSchema>;

/**
 * Apply one change to a prototype's state. 404 for an unknown prototype, 400
 * for a `tagId` that names no prototype tag.
 */
export const setPrototypeState = defineEndpoint({
  route: "PATCH /api/prototypes/:name/state",
  body: PrototypeStateChangeSchema,
  // Sets only the fields the request carries; a prototype with no row yet
  // enters the by-id read with the column defaults (the server creates the row
  // the same way). `updatedAt` is derived and follows by push.
  effect: (on) =>
    upsertRow(
      on,
      prototypeStateEntityRef,
      ({ params }) => params.name,
      (row, { params, body }) => ({
        ...(row ?? newStateRow(params.name)),
        ...(body.done === undefined ? {} : { done: body.done }),
        ...(body.pinned === undefined ? {} : { pinned: body.pinned }),
        ...(body.tagId === undefined ? {} : { tagId: body.tagId }),
      }),
    ),
});

/**
 * Delete a prototype: record `deletedAt` in its state. Nothing on disk moves —
 * the gallery hides it and lists it in its Trash, and every link to it keeps
 * working. Deleting a deleted prototype keeps the FIRST `deletedAt` (the Trash
 * says when it was deleted, not when someone last pressed Delete). 404 for an
 * unknown prototype. Per instance like the rest of the state: a delete in a
 * worktree (or an E2E run in it) never deletes on main.
 */
export const deletePrototype = defineEndpoint({
  route: "DELETE /api/prototypes/:name",
  // The FIRST `deletedAt` wins (the server's COALESCE). The instant is the
  // server's own clock, so it is shown, never compared; the write confirms by
  // commit.
  effect: (on) =>
    upsertRow(
      on,
      prototypeStateEntityRef,
      ({ params }) => params.name,
      (row, { params }) => {
        const base = row ?? newStateRow(params.name);
        return { ...base, deletedAt: base.deletedAt ?? new Date() };
      },
    ),
});

/** Restore a deleted prototype (clear its `deletedAt`). 404 for an unknown prototype. */
export const restorePrototype = defineEndpoint({
  route: "POST /api/prototypes/:name/restore",
  // Predicted: the prototype leaves the Trash at once (its state row's
  // `deletedAt` clears); `updatedAt` follows by push.
  effect: (on) =>
    patchRow(
      on,
      prototypeStateEntityRef,
      ({ params }) => params.name,
      () => ({ set: { deletedAt: null }, approx: { updatedAt: new Date() } }),
    ),
});
