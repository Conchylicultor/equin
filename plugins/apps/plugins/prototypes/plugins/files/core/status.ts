import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";

// The wire half of a prototype's status: whether the user has marked it Done,
// whether they pinned it (the gallery's Pinned section, above the rest), and
// whether they deleted it. A delete is a field here, not a move of the folder:
// a deleted prototype stays a prototype — its folder, history and picks stay
// where they are, every link to it keeps resolving, and it is listed in the
// gallery's Trash until restored.
// ONE record per prototype, shared by every surface (main, every worktree
// deploy, every browser, the CLI), stored beside the picks as
// `_status/<id>.json` (`shared/status.ts`). Like the picks, it is about the
// prototype, not part of its design, so it never enters the folder.

/** A prototype's status as STORED. No file is {@link NO_PROTOTYPE_STATUS}. */
export interface PrototypeStatus {
  /** The user has marked this prototype Done. */
  readonly done: boolean;
  /** The user has pinned this prototype — grouped above the rest in the gallery. */
  readonly pinned: boolean;
  /** When the user deleted it (ISO instant) — `null` while it is not deleted. */
  readonly deletedAt: string | null;
}

export const PrototypeStatusSchema = z.object({
  done: z.boolean().default(false),
  // Files written before pins existed hold `done` alone: not pinned.
  pinned: z.boolean().default(false),
  // Files written before deletion was a status hold no `deletedAt`: not deleted.
  deletedAt: z.string().datetime().nullable().default(null),
}) satisfies ZodParser<PrototypeStatus>;

/** The status of a prototype that has none recorded. */
export const NO_PROTOTYPE_STATUS: PrototypeStatus = {
  done: false,
  pinned: false,
  deletedAt: null,
};

/**
 * One change to a prototype's status: the fields it sets, never the whole
 * record, so ticking Done cannot clobber a pin set elsewhere (and vice versa).
 */
export const PrototypeStatusChangeSchema = z
  .object({ done: z.boolean().optional(), pinned: z.boolean().optional() })
  .refine((c) => c.done !== undefined || c.pinned !== undefined, {
    message: "a status change sets `done`, `pinned`, or both",
  });
export type PrototypeStatusChange = z.infer<typeof PrototypeStatusChangeSchema>;

/**
 * What the store folds: a {@link PrototypeStatusChange}, or a delete / restore.
 * `deletedAt` is never in the PUT body — only the server's delete and restore
 * endpoints write it, stamping the instant themselves.
 */
export type PrototypeStatusEdit = PrototypeStatusChange & {
  readonly deletedAt?: string | null;
};

/** `status` with `edit` applied — the one fold. */
export function applyPrototypeStatusChange(
  status: PrototypeStatus,
  edit: PrototypeStatusEdit,
): PrototypeStatus {
  return {
    done: edit.done ?? status.done,
    pinned: edit.pinned ?? status.pinned,
    // Deleting a deleted prototype keeps the FIRST instant: the Trash says
    // when it was deleted, not when someone last pressed Delete.
    deletedAt:
      edit.deletedAt === undefined
        ? status.deletedAt
        : edit.deletedAt === null
          ? null
          : (status.deletedAt ?? edit.deletedAt),
  };
}

/**
 * Every recorded status, keyed by prototype id (push, served from the status
 * store — `source: "external"`). A prototype missing from the map has no
 * status recorded — `NO_PROTOTYPE_STATUS`, a legitimate answer once loaded, and
 * never a stand-in before: until the map is read it is pending. One small
 * record per prototype, so it is bounded by the prototype list it annotates
 * (which the gallery already holds whole). Notified by the writer the moment it
 * writes, and by the watcher on every other backend.
 */
export const prototypeStatuses = liveValue("prototypes.statuses", {
  schema: z.record(z.string(), PrototypeStatusSchema),
});

/** The status recorded for `name` in a statuses map. */
export function statusOf(
  statuses: Record<string, PrototypeStatus>,
  name: string,
): PrototypeStatus {
  return statuses[name] ?? NO_PROTOTYPE_STATUS;
}

/**
 * Apply one change to a prototype's status. 404 for an unknown prototype. An
 * automated browser session's change is recorded in the agent-write ledger and
 * put back at the end of its run.
 */
export const setPrototypeStatus = defineEndpoint({
  route: "PUT /api/prototypes/:name/status",
  body: PrototypeStatusChangeSchema,
});

/**
 * Delete a prototype: record `deletedAt` in its status. Nothing on disk moves —
 * the gallery hides it and lists it in its Trash, and every link to it keeps
 * working. Deleting a deleted prototype keeps the first `deletedAt`. 404 for an
 * unknown prototype. An automated session's delete is undone at the end of its
 * run, like any status write.
 */
export const deletePrototype = defineEndpoint({
  route: "DELETE /api/prototypes/:name",
});

/** Restore a deleted prototype (clear its `deletedAt`). 404 for an unknown prototype. */
export const restorePrototype = defineEndpoint({
  route: "POST /api/prototypes/:name/restore",
});
