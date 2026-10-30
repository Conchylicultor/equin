import { z } from "zod";
import { idKindField } from "@plugins/ids/core";
import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
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
});

/** Restore a deleted prototype (clear its `deletedAt`). 404 for an unknown prototype. */
export const restorePrototype = defineEndpoint({
  route: "POST /api/prototypes/:name/restore",
});
