import { useLive } from "@plugins/network/plugins/live/web";
import {
  browserFileStat,
  computerFileStat,
  type FileLocation,
  type FileStat,
} from "../../core";

/**
 * One path described, as a reader branches on it:
 *
 * - `ready` — the path is there; `recheck` re-reads it (a grant of access
 *   changes no file, so no watch would);
 * - `missing` — nothing is there;
 * - `failed` — refused otherwise, or the read failed (`message` its words);
 * - `undescribed` — nothing to say: a file system this host cannot run, or
 *   one that describes no path (a checkout — its reads say what is there).
 */
export type FileStatState =
  | { kind: "loading" }
  | { kind: "ready"; stat: FileStat; recheck: () => Promise<void> }
  | { kind: "missing" }
  | { kind: "failed"; message: string }
  | { kind: "undescribed" };

/**
 * A path's stat, whichever file system holds it — pushed while read, so a
 * file that appears or goes swaps the answer.
 */
export function useFileStat(location: FileLocation): FileStatState {
  const computer = useLive(
    computerFileStat,
    location.fs === "computer" ? { path: location.path } : null,
  );
  const browser = useLive(
    browserFileStat,
    location.fs === "browser" ? { path: location.path } : null,
  );
  let read;
  switch (location.fs) {
    case "computer":
      read = computer;
      break;
    case "browser":
      read = browser;
      break;
    case "checkout":
      return { kind: "undescribed" };
  }
  switch (read.status) {
    case "unavailable":
      return { kind: "undescribed" };
    case "loading":
      return { kind: "loading" };
    case "ready":
      return { kind: "ready", stat: read.data, recheck: read.refetch };
    case "error":
      return read.error.kind === "refused" && read.error.code === "missing"
        ? { kind: "missing" }
        : { kind: "failed", message: read.error.message };
  }
}
