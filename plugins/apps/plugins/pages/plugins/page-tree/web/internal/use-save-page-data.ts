import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  pageData,
  updateBlock,
  type Block,
  type PageData,
} from "@plugins/page/plugins/editor/core";

/**
 * The one way the page header writes a page's `data` — the `PATCH` every
 * header part (title, icon, cover) goes through, spreading the change over the
 * page's CURRENT data so two parts never clobber each other's keys.
 */
export function useSavePageData(
  page: Block,
): (patch: Partial<PageData>) => Promise<void> {
  const { mutateAsync } = useEndpointMutation(updateBlock);
  return async (patch) => {
    await mutateAsync({
      params: { id: page.id },
      body: { data: { ...pageData(page), ...patch } },
    });
  };
}
