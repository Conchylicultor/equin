import {
  defaultNow,
  defineEntity,
} from "@plugins/infra/plugins/entities/server";
import { hintSeenEntityRef } from "../../core";

/**
 * One row per hint or tour the user has met, keyed by its declared id (the
 * single-column text pk IS the `hints.seen` collection's row id). Not config:
 * config forks per worktree and never syncs back, and resets on reload in a
 * browser-only host — seen state must survive both.
 *
 * An entity with no parent table: a hint is a code declaration, with no DB row
 * to hang off.
 */
export const hintSeenEntity = defineEntity(hintSeenEntityRef, {
  primaryKey: "hintId",
  columns: {
    seenAt: { default: defaultNow() },
  },
});

export const _hintSeen = hintSeenEntity.table;
