import { mapRow, useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { useOptimisticResource } from "@plugins/primitives/plugins/optimistic-mutation/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  pageTagAssignments,
  pageTagVocabulary,
  type PageTagAssignmentRow,
  type PageTagRow,
} from "../../core";
import { putPageTags } from "../../shared/endpoints";

/** The workspace's tag vocabulary, in creation order. */
export function useTagVocabulary(): ResourceResult<PageTagRow[]> {
  return useLive(pageTagVocabulary);
}

/**
 * The vocabulary rows `tagIds` name, in that order. An id the vocabulary no
 * longer holds (a tag deleted while this page's row was in flight) is skipped:
 * the server removes it from every page in the same transaction, so the next
 * push drops it anyway.
 */
function resolveTags(
  tagIds: readonly string[],
  vocabulary: readonly PageTagRow[],
): PageTagRow[] {
  const byId = new Map<string, PageTagRow>(vocabulary.map((t) => [t.id, t]));
  return tagIds.flatMap((id) => {
    const tag = byId.get(id);
    return tag === undefined ? [] : [tag];
  });
}

/**
 * The tags one page carries, in its order — resolved against the vocabulary.
 * `loading` until both reads land, never an empty stand-in: a page with no
 * assignment row is `ready` with `[]`.
 */
export function usePageTags(pageId: string): ResourceResult<PageTagRow[]> {
  // No assignment row is the page carrying no tags.
  const tagIds = mapRow(
    useLiveRow(pageTagAssignments, pageId),
    (row): readonly string[] => row?.tagIds ?? [],
  );
  const vocabulary = useTagVocabulary();
  return mapResource(
    combineResources({ tagIds, vocabulary }),
    ({ tagIds: ids, vocabulary: vocab }) => resolveTags(ids, vocab),
  );
}

/**
 * Every tagged page's tags, keyed by page id — the whole-set read a surface
 * listing many pages projects per row (the sidebar's field and its row
 * markers). A page absent from the map carries no tags.
 *
 * Cheap to call once per row: both reads are shared cache entries whose arrays
 * keep their identity until a push changes them, so the index is built once
 * per snapshot pair (a module-level `WeakMap`) and every row's call hits it.
 */
export function usePageTagIndex(): ResourceResult<
  ReadonlyMap<string, PageTagRow[]>
> {
  const assignments = useLive(pageTagAssignments);
  const vocabulary = useTagVocabulary();
  return mapResource(combineResources({ assignments, vocabulary }), (data) =>
    tagIndexOf(data.assignments, data.vocabulary),
  );
}

const indexCache = new WeakMap<
  readonly PageTagAssignmentRow[],
  WeakMap<readonly PageTagRow[], ReadonlyMap<string, PageTagRow[]>>
>();

function tagIndexOf(
  assignments: readonly PageTagAssignmentRow[],
  vocabulary: readonly PageTagRow[],
): ReadonlyMap<string, PageTagRow[]> {
  let byVocab = indexCache.get(assignments);
  if (byVocab === undefined) {
    byVocab = new WeakMap();
    indexCache.set(assignments, byVocab);
  }
  const cached = byVocab.get(vocabulary);
  if (cached !== undefined) return cached;
  const map = new Map<string, PageTagRow[]>();
  for (const a of assignments) {
    const tags = resolveTags(a.tagIds, vocabulary);
    if (tags.length > 0) map.set(a.pageId, tags);
  }
  byVocab.set(vocabulary, map);
  return map;
}

/** One page's tags, editable: what the header chips and the picker share. */
export interface PageTagsEditor {
  /** The page's tags, in order, with every pending edit already applied. */
  assigned: PageTagRow[];
  /** The whole vocabulary the picker lists. */
  vocabulary: PageTagRow[];
  /** Replace the page's tags with `tagIds`, in that order (`[]` clears them). */
  setTagIds: (tagIds: string[]) => void;
}

type SetTags = { tagIds: string[] };

/**
 * The page's tags with optimistic edits: a toggle repaints the chips at once,
 * and the PUT confirms when the assignment row the server pushes back carries
 * the same list (or, for `[]`, when the row is gone). Writes to one page go out
 * in order on the optimistic send lane, so two quick toggles cannot land
 * swapped.
 */
export function usePageTagsEditor(
  pageId: string,
): ResourceResult<PageTagsEditor> {
  const fetchEndpoint = useFetchEndpoint();
  const assignment = useOptimisticResource(
    pageTagAssignments,
    { ids: [pageId] },
    {
      label: "Page tags",
      apply: (_rows: PageTagAssignmentRow[], vars: SetTags) =>
        vars.tagIds.length === 0 ? [] : [{ pageId, tagIds: vars.tagIds }],
      mutate: async (vars: SetTags) => {
        await fetchEndpoint(putPageTags, { pageId }, { body: vars });
      },
      isConfirmedBy: (rows: PageTagAssignmentRow[], vars: SetTags) =>
        sameIds(rows[0]?.tagIds ?? [], vars.tagIds),
      // Every op on this tuple targets the one page's whole list.
      sameTarget: () => true,
      describeOp: (vars: SetTags) => `set ${vars.tagIds.length} tag(s)`,
    },
  );
  const vocabulary = useTagVocabulary();
  return mapResource(
    combineResources({ assignment, vocabulary }),
    ({ assignment: rows, vocabulary: vocab }): PageTagsEditor => ({
      assigned: resolveTags(rows[0]?.tagIds ?? [], vocab),
      vocabulary: vocab,
      setTagIds: (tagIds) => {
        // This arm is reached only once `assignment` is ready — the combined
        // read is all-or-nothing — so its `dispatch` (on the ready arm alone)
        // is there.
        if (assignment.status === "loading" || assignment.status === "error") {
          throw new Error(
            "page tags: an edit dispatched before the tags loaded",
          );
        }
        assignment.dispatch({ tagIds });
      },
    }),
  );
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
