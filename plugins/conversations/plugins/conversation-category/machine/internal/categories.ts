import { getConfig } from "@plugins/config_v2/server";
import { conversationCategoryConfig } from "../../shared/config";

/** One configured category, flattened to what the classifier and the set route need. */
export interface CategoryDescriptor {
  id: string;
  name: string;
  hint: string;
  items: { name: string; hint: string }[];
}

export function getCategories(): CategoryDescriptor[] {
  const { categories } = getConfig(conversationCategoryConfig);
  return categories.map((c) => ({
    id: c.id,
    name: c.name,
    hint: c.hint,
    items: c.items.map((i) => ({ name: i.name, hint: i.hint })),
  }));
}

export function findCategory(
  categoryId: string,
): CategoryDescriptor | undefined {
  return getCategories().find((c) => c.id === categoryId);
}
