import { useMemo } from "react";
import {
  DEFAULT_DRAFT_TTL,
  legacyDraftKeys,
  readDraft,
  writeDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import {
  defineStore,
  useStore,
  type Store,
  isKeyInScope,
  onStorageScopeCleared,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import type { PageSource } from "../../core";

/**
 * Which cut gestures have already been pasted — the client half of "a cut moves
 * its sub-pages ONCE" (see `PageSource` in `core/serialized-block.ts`).
 *
 * The first paste of a cut claims each cut page (it keeps its id, so the server
 * moves the page); every later paste of the same clipboard copies it. The
 * decision has to be made here, before dispatch, because the paste renders
 * optimistically under the ids it names — the server cannot choose a different
 * identity afterwards.
 *
 * Remembered in localStorage (so a second paste in another tab copies too) AND
 * in this module (so it still holds when storage is blocked). Losing the record
 * is benign: a repeated claim of a page that already moved just moves it again.
 */

const pastedCutStore = defineStore({
  owner: "page-editor.pasted-cut",
  label: "Cut-paste records",
  area: "local",
  cap: "256 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "evict-oldest",
  schema: z.literal(true),
  legacy: legacyDraftKeys("page-editor:pasted-cut"),
});
// By full key, so a cut is pasted once per composition scope it lives in.
const pastedThisSession = new Set<string>();
// A wiped scope (the demo's Reset) forgets its pastes, here too.
onStorageScopeCleared((id) => {
  for (const key of [...pastedThisSession])
    if (isKeyInScope(key, id)) pastedThisSession.delete(key);
});

type CutStore = Store<true>;

function wasPasted(store: CutStore, cutId: string): boolean {
  return (
    pastedThisSession.has(store.key(cutId)) ||
    readDraft(store, { scope: cutId }) !== null
  );
}

/** The cut claims of the composition scope this renders in. */
export interface CutClaims {
  /**
   * The claim predicate for `withPasteIds`: a cut page is claimed when its cut
   * has not been pasted yet and the page is not already a row of the forest
   * being pasted into (claiming it there would name one row twice).
   */
  claimCutPages(
    presentIds: ReadonlySet<string>,
  ): (source: PageSource) => boolean;
  /** Record that a paste consumed these cuts. */
  markCutsPasted(sources: readonly PageSource[]): void;
}

export function useCutClaims(): CutClaims {
  const store = useStore(pastedCutStore);
  return useMemo(
    () => ({
      claimCutPages: (presentIds) => (source) =>
        source.cutId !== undefined &&
        !wasPasted(store, source.cutId) &&
        !presentIds.has(source.pageId),
      markCutsPasted(sources) {
        for (const { cutId } of sources) {
          if (cutId === undefined || pastedThisSession.has(store.key(cutId)))
            continue;
          pastedThisSession.add(store.key(cutId));
          writeDraft(store, true, { scope: cutId });
        }
      },
    }),
    [store],
  );
}
