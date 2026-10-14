import { useMemo } from "react";
import { mapResource } from "@plugins/primitives/plugins/live-state/web";
import {
  FieldPresentation,
  type LiveFieldOption,
  type LiveFieldOptionsRead,
} from "@plugins/network/plugins/live/web";
import { pageTagAssignmentShape, type PageTagRow } from "../../core";
import { useTagVocabulary } from "./hooks";

/** The vocabulary as the `tags` field's options: each tag's id, named. */
function tagOptions(vocabulary: readonly PageTagRow[]): LiveFieldOption[] {
  return vocabulary.map((t) => ({ value: t.id, label: t.name }));
}

/**
 * The `tags` field's options, read from the LIVE vocabulary — a tag created
 * today is filterable at once. Loading until the vocabulary settles: never an
 * empty option list.
 */
export function useTagOptions(): LiveFieldOptionsRead {
  const vocabulary = useTagVocabulary();
  return useMemo(() => mapResource(vocabulary, tagOptions), [vocabulary]);
}

/**
 * A page's tags in every list whose rows are blocks: a filter / group
 * dimension, not body text (a list's rows carry their own marks — the pages
 * sidebar's dots), so off the body by default; its options the vocabulary.
 */
export const tagsPresentation = FieldPresentation.Register({
  owner: pageTagAssignmentShape.exposure,
  fields: { tagIds: { visible: false, useOptions: useTagOptions } },
});
