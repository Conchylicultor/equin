import type { WebCatalog } from "@plugins/framework/plugins/list-catalog/core";

/** What `@composition-web-catalog` resolves to under vitest: no lists, no entries. */
export const webCatalog: WebCatalog = {
  lists: [],
  entries: [],
  companionProviders: {},
};
