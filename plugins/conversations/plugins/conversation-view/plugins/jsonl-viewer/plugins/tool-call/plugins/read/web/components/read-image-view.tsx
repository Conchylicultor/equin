import { AssetThumbnail } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import {
  fileRefForPath,
  fileUrl,
} from "@plugins/primitives/plugins/file-viewer/core";

/**
 * The picture a Read call opened. Its path is as the tool got it — relative to
 * the worktree, or absolute anywhere on the host (a screenshot in a temp dir) —
 * so the bytes come from the checkout or from host-fs accordingly.
 */
export function ReadImageView({
  worktree,
  worktreePath,
  filePath,
}: {
  worktree: string;
  /** The worktree's absolute root, so an absolute path inside it reads from git. */
  worktreePath: string;
  filePath: string;
}) {
  const asset = fileUrl(
    fileRefForPath(worktree, filePath, { root: worktreePath }),
  );
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);

  return <AssetThumbnail asset={asset} image={{ name, sourceLabel: "Read" }} />;
}
