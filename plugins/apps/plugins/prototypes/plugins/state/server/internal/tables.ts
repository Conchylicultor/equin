import {
  defaultNow,
  defineEntity,
} from "@plugins/infra/plugins/entities/server";
import { defineTagTreeTable } from "@plugins/tag-tree/plugins/engine/server";
import { prototypeStateEntityRef, prototypeTagsEntityRef } from "../../core";

// Physical tables for the prototypes' per-instance state, derived from the
// refs in `core/`. A load-order leaf (no top-level await): drizzle-kit's sync
// loader evaluates it. Re-exported with a leading `_` for its schema glob.

const prototypeTags = defineTagTreeTable(prototypeTagsEntityRef);

const prototypeState = defineEntity(prototypeStateEntityRef, {
  primaryKey: "id",
  updatedAt: {
    touchedBy: {
      id: false,
      pinned: true,
      done: true,
      tagId: true,
      deletedAt: true,
      createdAt: false,
    },
  },
  columns: {
    pinned: { default: false },
    done: { default: false },
    // A deleted tag's carriers get its parent first (the tree's carrier, in
    // the delete's transaction); the FK's SET NULL is the backstop.
    tagId: {
      references: {
        column: () => _prototypeTags.id,
        onDelete: "set null",
      },
    },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
});

// drizzle-kit schema-glob discovery.
export const _prototypeTags = prototypeTags.table;
export const _prototypeState = prototypeState.table;
