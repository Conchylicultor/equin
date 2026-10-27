import {
  hostFsCompletions,
  hostFsPathStat,
  isBrowsable,
} from "@plugins/infra/plugins/host-fs/core";
import {
  HOME,
  absolutePath,
  displayPath,
  hostHome,
} from "@plugins/infra/plugins/host-account/core";
import { useLive, type LiveReader } from "@plugins/network/plugins/live/web";
import type { ResourceError } from "@plugins/primitives/plugins/live-state/web";
import type {
  PathBarSource,
  PathResolution,
  Suggestions,
} from "@plugins/primitives/plugins/path-bar/web";
import { baseName, isWithin, pathChain } from "../../core";

/**
 * The user's home directory, absolute — what `~` stands for. Every comparison
 * between a typed path and a listed one goes through it. Read from the
 * backend account's `host-account.home` live value (fixed for the process);
 * pending until it arrives. `unavailable` on a host without the computer (the
 * demo), which has no home folder — `message` says so.
 */
export type HomeDir =
  | { kind: "pending" }
  | { kind: "ready"; home: string }
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> }
  | { kind: "unavailable"; message: string };

export function useHomeDir(): HomeDir {
  const home = useLive(hostHome);
  switch (home.status) {
    case "loading":
      return { kind: "pending" };
    case "error":
      return { kind: "failed", error: home.error, refetch: home.refetch };
    case "ready":
      return { kind: "ready", home: home.data };
    case "unavailable":
      return { kind: "unavailable", message: home.message };
  }
}

/**
 * A crumb's label: "Home" for `~`, the volume's name for `/` (`rootName`,
 * once `host-fs.volume` has named it; the path itself until then).
 */
export function crumbLabel(path: string, rootName: string | undefined): string {
  if (path === HOME) return "Home";
  if (path === "/") return rootName ?? "/";
  return baseName(path);
}

/**
 * The host filesystem as a path-bar source: crumbs from the path itself,
 * folder completions read live from `host-fs.complete` (`useLive`, one tuple
 * per text typed, pushed while the folder searched changes), and validation
 * one `host-fs.stat` answer to the commit (`read`, the subtree's
 * `useLiveReader()` — a file resolves to itself, so the explorer opens its
 * folder and previews it). Paths come back in display form (`~/…` under home).
 *
 * With a `root` (an embedded browser), the bar never leads above it: the
 * crumbs start at the root, completions outside it are dropped, and a typed
 * path outside it is invalid.
 */
export function hostPathSource(
  read: LiveReader,
  home: string,
  rootName: string | undefined,
  root?: string,
): PathBarSource {
  const rootAbs = root === undefined ? undefined : absolutePath(root, home);
  const inRoot = (path: string) =>
    rootAbs === undefined || isWithin(absolutePath(path, home), rootAbs);
  return {
    segments: (path) =>
      pathChain(path)
        .filter(inRoot)
        .map((p) => ({
          key: p,
          label: crumbLabel(p, rootName),
          path: p,
        })),
    useComplete: (prefix): Suggestions => {
      const answer = useLive(
        hostFsCompletions,
        prefix === null ? null : { prefix },
      );
      switch (answer.status) {
        case "loading":
          return { kind: "pending" };
        // No computer behind the app: nothing can be listed, which is a
        // failure of the completion, not an empty answer.
        case "unavailable":
          return { kind: "failed", message: answer.message };
        case "ready":
          return {
            kind: "ready",
            items: answer.data.matches
              .filter((m) => inRoot(m.path))
              .map((m) => displayPath(m.path, home)),
          };
        case "error":
          // Typed into a folder that is not there (or into a file): no folder
          // completes it, which is the answer, not a failure. Anything else —
          // a spelling no folder has, a denied folder, a read that failed —
          // is shown as why there are none.
          if (
            answer.error.kind === "refused" &&
            (answer.error.code === "missing" ||
              answer.error.code === "not-a-dir")
          ) {
            return { kind: "ready", items: [] };
          }
          return { kind: "failed", message: answer.error.message };
      }
    },
    validate: async (path): Promise<PathResolution> => {
      const answer = await read(hostFsPathStat, { path });
      switch (answer.status) {
        case "unavailable":
          return { kind: "invalid", path, reason: answer.message };
        case "ready": {
          const stat = answer.data;
          if (!inRoot(stat.path)) {
            return {
              kind: "invalid",
              path,
              reason: `Outside ${displayPath(rootAbs ?? "/", home)}`,
            };
          }
          return {
            kind: isBrowsable(stat.entry) ? "dir" : "file",
            path: displayPath(stat.path, home),
          };
        }
        case "refused":
          switch (answer.code) {
            case "missing":
              return {
                kind: "invalid",
                path,
                reason: "No such file or folder",
              };
            case "denied":
              return { kind: "invalid", path, reason: "Permission denied" };
            // Not a path at all, or an archive that cannot be read: the
            // refusal's message says which.
            case "invalid-path":
            case "unreadable-archive":
              return { kind: "invalid", path, reason: answer.message };
          }
      }
    },
  };
}
