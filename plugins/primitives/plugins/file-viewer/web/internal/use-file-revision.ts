import { useEffect, useState } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { codeFileVersion } from "@plugins/code-explorer/plugins/code-api/core";
import { hostFsVersion } from "@plugins/infra/plugins/host-fs/core";
import { fileRefKey, type FileRef } from "../../core";

// The token a revision of "nothing there" reads as — the stamp is null then.
const ABSENT = "absent";

/**
 * How far `file` has moved on disk since this reader first saw it:
 * `undefined` while it has not (or its revision is not known yet), else the
 * current revision's token, which changes on every later write. A read as of
 * a git ref never moves.
 *
 * Pushed, never polled: the revision is a live value (code-api's
 * `codeFileVersion` for a workspace file, host-fs's `hostFsVersion` for a host
 * one) the server moves from a watch of the file's folder while it is read. It
 * carries no content — the reader re-reads its own when the token moves, so a
 * file shown is refreshed in place while its view is mounted. A refused or
 * failed revision read leaves the token unmoved; the content read beside it
 * reports the same file's trouble itself.
 */
export function useFileRevision(file: FileRef): string | undefined {
  const ws =
    file.source === "workspace" && file.ref === undefined ? file : null;
  const host = file.source === "host" ? file : null;
  const wsVersion = useLive(
    codeFileVersion,
    ws === null ? null : { worktree: ws.workspace, path: ws.path },
  );
  const hostVersion = useLive(
    hostFsVersion,
    host === null ? null : { path: host.path },
  );
  const read = ws !== null ? wsVersion : hostVersion;
  const stamp =
    read.status === "ready" ? (read.data.stamp ?? ABSENT) : undefined;

  // The first revision seen for this file is the baseline the content read
  // already reflects; only a later one is a change.
  const key = fileRefKey(file);
  const [baseline, setBaseline] = useState<{ key: string; stamp: string }>();
  if (stamp !== undefined && baseline?.key !== key) {
    setBaseline({ key, stamp });
  }
  return baseline?.key === key &&
    stamp !== undefined &&
    stamp !== baseline.stamp
    ? stamp
    : undefined;
}

/** Run `refetch` each time `file`'s revision moves (see {@link useFileRevision}). */
export function useRefetchOnFileChange(
  file: FileRef,
  refetch: () => unknown,
): void {
  const revision = useFileRevision(file);
  useEffect(() => {
    if (revision !== undefined) void refetch();
  }, [revision, refetch]);
}
