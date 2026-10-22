import {
  assetPath,
  type AssetPath,
} from "@plugins/infra/plugins/endpoints/core";
import { getImageContent } from "./endpoints";

/**
 * One of a worktree's image files, as an asset an element loads — through
 * `useAssetSrc` (`endpoints/web`), over the subtree's transport, never as a
 * bare URL.
 *
 * An asset rather than a typed fetch, because the consumer is the browser's own
 * image loader, which is handed an address and never a parsed body. (A caller
 * that wants the bytes themselves reads `getImageContent` with `fetchEndpoint`.)
 *
 * Built from that endpoint's own declaration rather than from a second spelling
 * of `/api/code/:worktree/image`, so the four surfaces that show a worktree
 * image (a Read tool call, the file-peek pane, a side-by-side image diff, an
 * image in rendered markdown) cannot drift from the route that serves them, and
 * whether it needs the computer is the route's own `needsMachine`.
 *
 * `ref` names a git revision to read the file AS OF (the diff's old side); its
 * absence means the file as it is on disk right now.
 */
export function codeImageUrl(
  worktree: string,
  path: string,
  opts: { ref?: string } = {},
): AssetPath {
  return assetPath(
    getImageContent,
    { worktree },
    opts.ref !== undefined ? { path, ref: opts.ref } : { path },
  );
}
