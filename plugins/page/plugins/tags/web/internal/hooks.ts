import { useMemo } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  exposedColumns,
  type ContributedColumns,
} from "@plugins/network/plugins/live/core";
import {
  pageTagAssignments,
  pageTagAssignmentShape,
  pageTagVocabulary,
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
    useLive(pageTagAssignments, { id: pageId }),
    (row): readonly string[] => row?.tagIds ?? [],
  );
  const vocabulary = useTagVocabulary();
  return mapResource(
    combineResources({ tagIds, vocabulary }),
    ({ tagIds: ids, vocabulary: vocab }) => resolveTags(ids, vocab),
  );
}

/** The `tags` field every list whose rows are blocks carries (`$columns`). */
const tagColumns = exposedColumns(pageTagAssignmentShape.exposure);

/**
 * A listed page's tags, in its order — read off the ROW (the `tags` field the
 * extension exposes on every list whose rows are blocks, e.g. a
 * `pages.tree.v2` window row), resolved against the vocabulary: a list never
 * reads every page's tags to mark the rows it shows. `loading` until the
 * vocabulary lands; an untagged page (NULL) is `ready` with `[]`.
 */
export function useListedPageTags(row: {
  readonly $columns: ContributedColumns;
}): ResourceResult<PageTagRow[]> {
  const tagIds = tagColumns.read(row).tagIds;
  const vocabulary = useTagVocabulary();
  return useMemo(
    () => mapResource(vocabulary, (vocab) => resolveTags(tagIds ?? [], vocab)),
    [vocabulary, tagIds],
  );
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
 * The page's tags and the vocabulary, editable: `setTagIds` sends the whole
 * list (`putPageTags`), and the chips repaint when the assignment row the
 * server pushes back carries it.
 */
export function usePageTagsEditor(
  pageId: string,
): ResourceResult<PageTagsEditor> {
  const tagIds = mapRow(
    useLive(pageTagAssignments, { id: pageId }),
    (row): readonly string[] => row?.tagIds ?? [],
  );
  const put = useEndpointMutation(putPageTags);
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
