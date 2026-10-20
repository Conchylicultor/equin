import type {
  HostFsDirPeek,
  HostFsEntry,
} from "@plugins/infra/plugins/host-fs/core";
import { joinPath } from "./paths";

/**
 * Whether the browser shows a listed entry, `path` in display form: Show
 * hidden files and every lens's hide rule decide it. It reads only `hidden`
 * and the path, so a peeked child (a name and a hidden flag) is judged by the
 * very rule a listed entry is.
 */
export type EntryFilter = (
  entry: Pick<HostFsEntry, "hidden">,
  path: string,
) => boolean;

/**
 * Why a host-fs folder read (`host-fs.list` / `host-fs.peek`) refused, as its
 * declared refusal code and the server's message.
 */
export interface FolderRefusal {
  kind: "refused";
  code:
    "invalid-path" | "missing" | "denied" | "not-a-dir" | "unreadable-archive";
  message: string;
}

/** A folder's own listing, as far as counting it goes. */
export type ListedFolder =
  | { kind: "listed"; entries: readonly Pick<HostFsEntry, "name" | "hidden">[] }
  | FolderRefusal;

/** How many items a folder holds, as its Size cell shows it. */
export type ItemCount =
  /** The visible items, by the browser's current visibility rules. */
  | { kind: "count"; n: number }
  /** Too many to ship the names: every item, visibility rules not applied. */
  | { kind: "many"; total: number }
  | { kind: "denied" }
  /** An archive that cannot be read (or a path no read takes): why, in words. */
  | { kind: "unreadable"; message: string }
  /** Gone since its parent was listed, or no longer a folder. */
  | { kind: "gone" }
  | { kind: "loading" };

/**
 * The item count of the folder at `path`. Its own listing wins when it is
 * listed (an expanded folder costs no read); otherwise its peek (child names
 * only). `listed` is what the folder's listing answered, if it was asked for
 * and has answered; `peek` its peek's answer once one arrived. Neither yet is
 * loading — never a 0.
 */
export function itemCount(
  path: string,
  listed: ListedFolder | undefined,
  peek: HostFsDirPeek | FolderRefusal | undefined,
  shows: EntryFilter,
): ItemCount {
  if (listed?.kind === "listed") {
    return {
      kind: "count",
      n: listed.entries.filter((e) => shows(e, joinPath(path, e.name))).length,
    };
  }
  if (peek !== undefined) {
    switch (peek.kind) {
      case "ok":
        return {
          kind: "count",
          n: peek.children.filter((c) => shows(c, joinPath(path, c.name)))
            .length,
        };
      case "too-many":
        return { kind: "many", total: peek.total };
      // A folder row whose path is now an archive file: replaced since listed.
      case "archive":
        return { kind: "gone" };
      case "refused":
        return failed(peek);
    }
  }
  return listed === undefined ? { kind: "loading" } : failed(listed);
}

function failed(refusal: FolderRefusal): ItemCount {
  switch (refusal.code) {
    case "denied":
      return { kind: "denied" };
    case "unreadable-archive":
    case "invalid-path":
      return { kind: "unreadable", message: refusal.message };
    case "missing":
    case "not-a-dir":
      return { kind: "gone" };
  }
}
