import { useEffect, useState } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { codeFileVersion } from "@plugins/code-explorer/plugins/code-api/core";
import { fileRefKey, type FileRef } from "../../core";

// The token a revision of "nothing there" reads as — the stamp is null then.
const ABSENT = "absent";

/** A file in a workspace — the one source whose content read is not live yet. */
type WorkspaceFileRef = Extract<FileRef, { source: "workspace" }>;

/**
 * How far the workspace file `file` has moved on disk since this reader first
 * saw it: `undefined` while it has not (or its revision is not known yet, or
 * `file` is `null`), else the current revision's token, which changes on every
 * later write. A read as of a git ref never moves.
 *
 * Pushed, never polled: the revision is code-api's `codeFileVersion` live
 * value, which the server moves from a watch of the file's folder while it is
 * read. It carries no content — the reader re-reads its own when the token
 * moves, so a file shown is refreshed in place while its view is mounted. A
 * refused or failed revision read leaves the token unmoved; the content read
 * beside it reports the same file's trouble itself.
 *
 * A host file needs none of this: its reads (`host-fs.text`,
 * `file-viewer.bytes`) are live values the server invalidates itself.
 */
export function useFileRevision(
  file: WorkspaceFileRef | null,
): string | undefined {
  const ws = file !== null && file.ref === undefined ? file : null;
  const read = useLive(
    codeFileVersion,
    ws === null ? null : { worktree: ws.workspace, path: ws.path },
  );
  // Only a revision the server vouches for moves the token: one not known
  // yet, refused, failed or unreadable here leaves it where it was.
  let stamp: string | undefined;
  switch (read.status) {
    case "ready":
      stamp = read.data.stamp ?? ABSENT;
      break;
    case "loading":
    case "error":
    case "unavailable":
      stamp = undefined;
      break;
  }

  // The first revision seen for this file is the baseline the content read
  // already reflects; only a later one is a change.
  const key = file === null ? null : fileRefKey(file);
  const [baseline, setBaseline] = useState<{ key: string; stamp: string }>();
  if (key !== null && stamp !== undefined && baseline?.key !== key) {
    setBaseline({ key, stamp });
  }
  return key !== null &&
    baseline?.key === key &&
    stamp !== undefined &&
    stamp !== baseline.stamp
    ? stamp
    : undefined;
}

/** Run `refetch` each time `file`'s revision moves (see {@link useFileRevision}). */
export function useRefetchOnFileChange(
  file: WorkspaceFileRef | null,
  refetch: () => unknown,
): void {
  const revision = useFileRevision(file);
  useEffect(() => {
    if (revision !== undefined) void refetch();
  }, [revision, refetch]);
}
