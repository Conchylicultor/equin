import { useLive } from "@plugins/network/plugins/live/web";
import {
  FILE_PEEK_MAX_NAMES,
  browserFileListing,
  computerFileListing,
  type BrowsableFileSystem,
} from "../../core";

/**
 * A folder's listing in `fs`, both halves: its entries (every page live, up
 * to {@link FILE_PEEK_MAX_NAMES} — the most a reader with no viewport holds,
 * in code-point name order) and its meta (resolved path, parent, total,
 * `within`), pushed while read. `null` reads nothing. Every system's read is
 * declared every render (hooks cannot be conditional); the others read
 * nothing. A system this host cannot run is `unavailable`, nothing read.
 */
// The return type is the systems' reads as they are — the computer's adds
// the `unavailable` arm, which the union carries.
export function useFolderListing(fs: BrowsableFileSystem, path: string | null) {
  const computerQ = fs === "computer" && path !== null ? { path } : null;
  const browserQ = fs === "browser" && path !== null ? { path } : null;
  const computerPages = useLive(computerFileListing, computerQ, {
    limit: FILE_PEEK_MAX_NAMES,
  });
  const computerMeta = useLive(computerFileListing.meta, computerQ);
  const browserPages = useLive(browserFileListing, browserQ, {
    limit: FILE_PEEK_MAX_NAMES,
  });
  const browserMeta = useLive(browserFileListing.meta, browserQ);
  switch (fs) {
    case "computer":
      return { pages: computerPages, meta: computerMeta };
    case "browser":
      return { pages: browserPages, meta: browserMeta };
  }
}
