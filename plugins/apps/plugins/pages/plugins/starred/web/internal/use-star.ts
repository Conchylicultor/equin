import type React from "react";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { putPageStarred } from "../../shared/endpoints";
import { useStarredPageIds } from "./use-starred-ids";

/**
 * Shared read + toggle logic for both star toggle surfaces (row + header).
 * Loading (or failed) until the favorites window lands: a toggle whose flip is
 * computed from a guess would star an already-starred page instead of
 * unstarring it.
 */
export function useStar(pageId: string): ResourceResult<{
  isStarred: boolean;
  toggle: (e: React.MouseEvent) => void;
}> {
  const starred = useStarredPageIds();
  const { mutate } = useLiveMutation(putPageStarred);
  return mapResource(starred, (ids) => {
    const isStarred = ids.has(pageId);
    const toggle = (e: React.MouseEvent) => {
      e.stopPropagation();
      mutate({ params: { pageId }, body: { starred: !isStarred } });
    };
    return { isStarred, toggle };
  });
}
