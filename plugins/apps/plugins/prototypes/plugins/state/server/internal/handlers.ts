import { eq, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { protoIdKind } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { prototypeExists } from "@plugins/apps/plugins/prototypes/plugins/files/server";
import {
  deletePrototype,
  prototypeTagIdKind,
  restorePrototype,
  setPrototypeState,
} from "../../core";
import { _prototypeState, _prototypeTags } from "./tables";

/**
 * `PATCH /api/prototypes/:name/state` — apply one change (`{ done?, pinned?,
 * tagId? }`): an upsert that sets only the given fields, so a change never
 * clobbers another field set elsewhere. 404 unless the prototype folder
 * exists; 400 for a `tagId` that names no prototype tag.
 */
export const handleSetPrototypeState = implement(
  setPrototypeState,
  async ({ params, body }) => {
    const { name } = params;
    if (!protoIdKind.is(name) || !(await prototypeExists(name))) {
      throw new HttpError(404, `no such prototype: ${name}`);
    }
    const set: Partial<typeof _prototypeState.$inferInsert> = {};
    if (body.done !== undefined) set.done = body.done;
    if (body.pinned !== undefined) set.pinned = body.pinned;
    if (body.tagId !== undefined) set.tagId = body.tagId;
    await db.transaction(async (tx) => {
      const { tagId } = body;
      if (tagId !== undefined && tagId !== null) {
        // Under a KEY SHARE lock, so a concurrent delete of the tag waits for
        // this write (and then lifts it to the parent through the carrier).
        const tag = prototypeTagIdKind.is(tagId)
          ? await tx
              .select({ id: _prototypeTags.id })
              .from(_prototypeTags)
              .where(eq(_prototypeTags.id, tagId))
              .for("key share")
          : [];
        if (tag.length === 0) {
          throw new HttpError(400, `no such prototype tag: ${tagId}`);
        }
      }
      await tx
        .insert(_prototypeState)
        .values({ id: name, ...set })
        // `updatedAt` is derived (a trigger moves it when a field changes).
        .onConflictDoUpdate({ target: _prototypeState.id, set });
    });
  },
);

/**
 * `DELETE /api/prototypes/:name` — record `deletedAt` (now). Nothing on disk
 * moves, so a delete is as reversible as a Done tick (Restore). A prototype
 * already deleted keeps its first `deletedAt`. 404 unless the folder exists.
 */
export const handleDeletePrototype = implement(
  deletePrototype,
  async ({ params }) => {
    const { name } = params;
    if (!protoIdKind.is(name) || !(await prototypeExists(name))) {
      throw new HttpError(404, `no such prototype: ${name}`);
    }
    await db
      .insert(_prototypeState)
      .values({ id: name, deletedAt: new Date() })
      .onConflictDoUpdate({
        target: _prototypeState.id,
        set: {
          deletedAt: sql`COALESCE(${_prototypeState.deletedAt}, excluded.deleted_at)`,
        },
      });
  },
);

/** `POST /api/prototypes/:name/restore` — clear `deletedAt`. 404 unless the folder exists. */
export const handleRestorePrototype = implement(
  restorePrototype,
  async ({ params }) => {
    const { name } = params;
    if (!protoIdKind.is(name) || !(await prototypeExists(name))) {
      throw new HttpError(404, `no such prototype: ${name}`);
    }
    // No row = not deleted: nothing to clear.
    await db
      .update(_prototypeState)
      .set({ deletedAt: null })
      .where(eq(_prototypeState.id, name));
  },
);
