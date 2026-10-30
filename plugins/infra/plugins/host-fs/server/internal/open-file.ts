import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import type { HostFsArchiveReason } from "../../core";
import { locateHostPath } from "./archive/locate";
import { openArchiveMember, statArchiveMember } from "./archive/read";
import { classifyFsError } from "./path";
import type { UserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * One host file, opened for a consumer that needs its whole bytes (a decoder,
 * a resizer): what identifies this version of it (`size`, `mtimeMs`) without
 * reading it, and `read()` for the bytes. Works the same for a file on disk and
 * a member inside an archive, so a consumer never names the two.
 */
export type HostFileOpen =
  | {
      kind: "ok";
      /** The resolved absolute path (`~` expanded, `..` collapsed). */
      path: string;
      size: number;
      mtimeMs: number;
      /** A plain file on disk at `path` (a reader may open it itself), or an archive member. */
      onDisk: boolean;
      read(): Promise<Uint8Array>;
    }
  | { kind: "missing" | "denied" | "not-a-file"; path: string }
  | {
      kind: "unreadable-archive";
      path: string;
      archive: string;
      reason: HostFsArchiveReason;
    };

/**
 * Open the host file at `path` — resolved by `resolveHostPath` (or a read's
 * `resolveOrRefuse`), which answers a bad spelling with its 400.
 */
export async function openHostFile(path: UserPath): Promise<HostFileOpen> {
  const located = await locateHostPath(path);
  if (located.kind === "archive") {
    const described = await statArchiveMember(path, located);
    if (described.kind !== "ok") return described;
    if (described.entry.kind !== "file") return { kind: "not-a-file", path };
    return {
      kind: "ok",
      path,
      size: described.entry.size,
      mtimeMs: described.entry.mtimeMs,
      onDisk: false,
      async read() {
        const opened = await openArchiveMember(path, located);
        if (opened.kind !== "ok")
          throw new Error(`${path}: ${opened.kind} after it was described`);
        return new Response(opened.body).bytes();
      },
    };
  }
  try {
    const st = await stat(path);
    if (!st.isFile()) return { kind: "not-a-file", path };
    // `stat` needs only search permission on the parents; reading needs read
    // permission on the file — denied now, not halfway through a read.
    await access(path, constants.R_OK);
    return {
      kind: "ok",
      path,
      size: st.size,
      mtimeMs: st.mtimeMs,
      onDisk: true,
      read: () => Bun.file(path).bytes(),
    };
  } catch (err) {
    return { kind: classifyFsError(err), path };
  }
}
