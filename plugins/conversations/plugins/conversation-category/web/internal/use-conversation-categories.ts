import { useMemo } from "react";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  categoryRowId,
  conversationCategories,
  type ConversationCategory,
} from "../../shared";

/**
 * The category assignments of one conversation, keyed by category id — for
 * exactly the categories the caller asks about.
 *
 * The caller naming its id set is the point: a sidebar row passes the ONE
 * avatar category, so a row costs one subscribed id. It reads the lookup-only
 * `conversationCategories` collection's `:rows` through `useLive(c, { ids })`,
 * which canonicalises the set, so the same logical set always shares one tuple.
 *
 * An empty `categoryIds` is legal and free — it encodes to an empty id set and
 * the server's point loader short-circuits without a query. That is what "no
 * avatar category chosen yet" looks like; no sentinel id is needed.
 *
 * On the settled arm a missing key means "not classified yet". "Not loaded
 * yet" stays the pending arm, so a classified conversation never paints as
 * unclassified during the load window.
 */
export function useCategoryRows(
  conversationId: string,
  categoryIds: readonly string[],
): ResourceResult<Map<string, ConversationCategory>> {
  const ids = useMemo(
    () =>
      categoryIds.map((categoryId) =>
        categoryRowId(conversationId, categoryId),
      ),
    [conversationId, categoryIds],
  );
  const result = useLive(conversationCategories, { ids });
  return useMemo(
    () =>
      mapResource(
        result,
        (rows) => new Map(rows.map((row) => [row.categoryId, row])),
      ),
    [result],
  );
}
