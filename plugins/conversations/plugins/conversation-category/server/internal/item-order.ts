/** The part of the categories config `itemOrder` reads. */
export interface CategoriesConfigValue {
  readonly categories: readonly {
    readonly id: string;
    readonly items: readonly { readonly name: string }[];
  }[];
}

/**
 * The configured item names of one category, in config order — the series order
 * a chart should render. Empty for an unknown category id, which is a legitimate
 * answer (the category was deleted from config), not a failure.
 *
 * Pure over the config value, so this portable half never reads the config
 * itself: a caller already on the desktop passes
 * `getConfig(conversationCategoryConfig)`.
 */
export function itemOrder(
  config: CategoriesConfigValue,
  categoryId: string,
): string[] {
  return (
    config.categories
      .find((c) => c.id === categoryId)
      ?.items.map((i) => i.name) ?? []
  );
}
