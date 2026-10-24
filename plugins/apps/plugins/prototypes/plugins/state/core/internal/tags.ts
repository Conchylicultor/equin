import { defineIdKind } from "@plugins/ids/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  defineTagTree,
  tagTreeEntityRef,
} from "@plugins/tag-tree/plugins/engine/core";

// The prototypes' tag tree — one `tag-tree` declaration (table, live
// collection, tree handle). Each prototype carries at most one tag of it
// (`prototype_state.tagId`, `./state.ts`).

/** A prototype tag's id: `prtag-<epochSeconds>-<6 base36>`. */
export const prototypeTagIdKind = defineIdKind({
  prefix: "prtag",
  label: "Prototype tag",
});

export const prototypeTagsEntityRef = tagTreeEntityRef("prototype_tags", {
  idKind: prototypeTagIdKind,
});

/**
 * Every prototype tag, live, in rank order — the whole tree. The spec is the
 * tag-tree spelling (pick the name, carry the rest) written out: the resource
 * scanners read a spec only as an inline object literal.
 */
export const prototypeTags = liveCollection("prototypes.tags.all", {
  from: prototypeTagsEntityRef,
  pick: ["name"],
  carry: {
    pick: [
      "id",
      "parentId",
      "color",
      "childColors",
      "icon",
      "rank",
      "createdAt",
      "updatedAt",
    ],
  },
  id: "id",
  all: {
    orderBy: [["rank", "asc"]],
    unbounded: {
      reason: "a person adds every tag by hand, and the tag tree is read whole",
    },
  },
});

/** The prototypes' tag tree: the `:tree` id `prototypes` of the tag-tree endpoints. */
export const prototypeTagTree = defineTagTree({
  id: "prototypes",
  entity: prototypeTagsEntityRef,
  collection: prototypeTags,
});
