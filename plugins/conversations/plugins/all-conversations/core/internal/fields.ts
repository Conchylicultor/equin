import {
  compareModelsNewestFirst,
  isPrintOnlyFamily,
  modelMeta,
  type ModelCatalog,
} from "@plugins/conversations/plugins/model-provider/core";

// What the conversation lists share beyond the fields themselves — which are
// declared once, on the `conversations` entity (tasks-core's
// `conversationFields`: labels, the title flag, enum options) and derived by
// every list from its collection (`./collection.ts`).

/**
 * The model filter's options: a conversation's model is the concrete version
 * it RAN, so the filter offers versions, never families — every version the
 * catalog knows, retired ones included (old conversations ran them), newest
 * first. Runtime data, so it is not part of the field's declaration: the
 * conversations entity's presentation reads it from the live catalog
 * (`web/internal/presentation.tsx`).
 */
export function conversationModelOptions(
  catalog: ModelCatalog,
): { value: string; label: string }[] {
  return catalog.versions
    .map((v) => v.id)
    .filter((id) => !isPrintOnlyFamily(modelMeta(id).family))
    .sort(compareModelsNewestFirst)
    .map((id) => ({ value: id, label: modelMeta(id).label }));
}

/**
 * What the lists sort by — index-backed, so explicit (the collections'
 * `sortable`).
 */
export const CONVERSATION_SORTABLE = [
  "title",
  "createdAt",
  "updatedAt",
] as const;

/** The text columns the search box matches (any of, case-insensitively). */
export const CONVERSATION_SEARCHABLE = [
  "title",
  "model",
  "worktreePath",
  "taskTitle",
] as const;
