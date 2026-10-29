import {
  mapRow,
  useLive,
  useLiveMutation,
  useLiveRow,
} from "@plugins/network/plugins/live/web";
import {
  combineResources,
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
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

/**
 * The page's tags with the pending edits applied: `putPageTags` is a predicted
 * write, so a toggle repaints the chips at once and the PUT confirms when the
 * assignment row the server pushes back carries the same list (or, for `[]`,
 * when the row is gone). Writes to one page go out in order on that row's send
 * lane, so two quick toggles cannot land swapped.
 */
export function usePageTagsEditor(
  pageId: string,
): ResourceResult<PageTagsEditor> {
  const tagIds = mapRow(
    useLiveRow(pageTagAssignments, pageId),
    (row): readonly string[] => row?.tagIds ?? [],
  );
  const put = useLiveMutation(putPageTags, { label: "Page tags" });
  const vocabulary = useTagVocabulary();
  return mapResource(
    combineResources({ tagIds, vocabulary }),
    ({ tagIds: ids, vocabulary: vocab }): PageTagsEditor => ({
      assigned: resolveTags(ids, vocab),
      vocabulary: vocab,
      setTagIds: (tagIds) =>
        put.mutate({ params: { pageId }, body: { tagIds } }),
    }),
  );
}
