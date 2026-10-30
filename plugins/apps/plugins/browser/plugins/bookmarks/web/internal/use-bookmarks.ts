import {
  useLive,
  type LiveListResult,
} from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { addBookmark, deleteBookmark } from "../../shared/endpoints";
import { browserBookmarks, type BookmarkRow } from "../../core";

/**
 * The bookmarks list for the bar: the `browserBookmarks` default window
 * (oldest first, 100 — `loadMore` grows it) plus the remove endpoint.
 *
 * The raw window result is exposed (never collapsed into a fake-empty list),
 * so the consumer switches on `.status` itself.
 */
export function useBookmarks(): {
  result: LiveListResult<BookmarkRow>;
  remove: (id: string) => Promise<void>;
} {
  const result = useLive(browserBookmarks);
  const { mutateAsync: del } = useEndpointMutation(deleteBookmark);

  const remove = async (id: string) => {
    await del({ params: { id } });
  };

  return { result, remove };
}

/**
 * Whether ONE url is bookmarked, and the toggle for it — the star's read. A
 * `{ where: { url }, limit: 1 }` window, so the server answers for this url
 * alone, whatever the list's size.
 *
 * Not known yet (and failed) are their own arms, and `toggle` exists only once
 * the answer is known: a click while loading cannot add a second bookmark for
 * a url that already has one.
 */
export function useBookmarkToggle(url: string): ResourceResult<{
  bookmarked: boolean;
  toggle: (title: string) => Promise<void>;
}> {
  const result = useLive(browserBookmarks, { where: { url }, limit: 1 });
  const { mutateAsync: add } = useEndpointMutation(addBookmark);
  const { mutateAsync: del } = useEndpointMutation(deleteBookmark);

  return mapResource(result, (rows) => {
    const existing = rows[0];
    const toggle = async (title: string) => {
      if (existing) {
        await del({ params: { id: existing.id } });
      } else {
        await add({ body: { url, title } });
      }
    };
    return { bookmarked: existing !== undefined, toggle };
  });
}
