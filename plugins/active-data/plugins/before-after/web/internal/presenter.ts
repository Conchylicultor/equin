import { useLive } from "@plugins/network/plugins/live/web";
import {
  paneTarget,
  type PaneTarget,
} from "@plugins/primitives/plugins/pane/web";
import { rowReferent } from "@plugins/active-data/plugins/id-chip/web";
import { beforeAfterPairs } from "@plugins/conversations/plugins/before-after/core";
import { beforeAfterPane } from "@plugins/conversations/plugins/before-after/web";
import type { IdReferentState } from "@plugins/ids/web";

/** A pair's chip title — what it shows — from the by-id row read. */
export function useBeforeAfterReferent(id: string): IdReferentState {
  return rowReferent(useLive(beforeAfterPairs, { id }), (r) => r.title);
}

/** The Before / after pane on the pair, beside the text holding the chip. */
export function useBeforeAfterPane(id: string): PaneTarget {
  return paneTarget(beforeAfterPane, { pair: id });
}
