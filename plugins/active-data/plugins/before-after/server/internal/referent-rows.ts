import { serveCollection } from "@plugins/network/plugins/live/server";
import { followedReferent } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/server";
import { baIdKind } from "@plugins/conversations/plugins/before-after/core";
import { _beforeAfterPairs } from "@plugins/conversations/plugins/before-after/server";
import { beforeAfterChipReferents } from "../../core";

/** `before-after-chip.referents` over `before_after_pairs`: its `id` and `title` columns. */
export const beforeAfterChipReferentsServed = serveCollection(
  beforeAfterChipReferents,
  { from: _beforeAfterPairs },
);

/** A live value's read of a `ba-…` chip: the pair's row, by the key the token names. */
export const beforeAfterChipLiveRead = followedReferent(
  beforeAfterChipReferentsServed,
  {
    idOf: (token) => baIdKind.key(token),
    referentOf: (row) => ({ found: true, title: row.title }),
  },
);
