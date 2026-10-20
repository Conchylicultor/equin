import { getConfig } from "@plugins/config_v2/server";
import {
  conversationCategoryConfig,
  getItemMap,
  itemOrder,
} from "@plugins/conversations/plugins/conversation-category/server";

const UNKNOWN = "Unknown";

/**
 * Which item each conversation carries within ONE category.
 *
 * A conversation is classified along every configured category now, so a
 * breakdown only means something once a category is named — the caller picks it,
 * and this plugin never names one itself.
 */
export async function buildItemMap(
  categoryId: string,
): Promise<Map<string, string>> {
  return getItemMap(categoryId);
}

export function itemFor(
  map: Map<string, string>,
  conversationId: string | null,
): string {
  if (!conversationId) return UNKNOWN;
  return map.get(conversationId) ?? UNKNOWN;
}

/** The category's configured item names, in config order — the series order. */
export function getConfigItemOrder(categoryId: string): string[] {
  return itemOrder(getConfig(conversationCategoryConfig), categoryId);
}
