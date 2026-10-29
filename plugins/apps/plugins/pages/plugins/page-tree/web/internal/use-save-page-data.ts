import { useLiveMutation } from "@plugins/network/plugins/live/web";
import {
  pageData,
  updateBlock,
  type Block,
  type PageData,
} from "@plugins/page/plugins/editor/core";

/**
 * The one way the page header writes a page's `data` — the `PATCH` every
 * header part (title, icon, cover) goes through, spreading the change over the
 * page's CURRENT data so two parts never clobber each other's keys. A predicted
 * write: the page row reads the new data at once.
 */
export function useSavePageData(
  page: Block,
): (patch: Partial<PageData>) => void {
  const update = useLiveMutation(updateBlock, { label: "Page" });
  return (patch) => {
    update.mutate({
      params: { id: page.id },
      body: { data: { ...pageData(page), ...patch } },
    });
  };
}
