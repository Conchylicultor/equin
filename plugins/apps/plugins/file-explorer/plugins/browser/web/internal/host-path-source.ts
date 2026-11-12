import { useMemo } from "react";
import {
  FILE_COMPLETE_LIMIT,
  FILE_SYSTEMS,
  computerFileCompletions,
  computerVolume,
  fileStatOf,
  isBrowsable,
  type BrowsableFileSystem,
  type FileSystemCapabilities,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import {
  HOME,
  absolutePath,
  displayPath,
  hostHome,
} from "@plugins/infra/plugins/host-account/core";
import { useFolderListing } from "@plugins/infra/plugins/paths/plugins/file-systems/web";
import {
  useLive,
  useLiveReader,
  type LiveReader,
} from "@plugins/network/plugins/live/web";
import type { ResourceError } from "@plugins/network/plugins/live/plugins/live-state/web";
import type {
  PathBarSource,
  PathResolution,
  Suggestions,
} from "@plugins/primitives/plugins/path-bar/web";
import { baseName, isWithin, pathChain } from "../../core";

/**
 * The user's home directory, absolute — what `~` stands for. Every comparison
 * between a typed path and a listed one goes through it. Read from the
 * backend account's `host-account.home` live value (the account's home, or the configured stand-in home folder, `standIn`);
 * pending until it arrives. `unavailable` on a host without the computer (the
 * demo), which has no home folder — `message` says so.
 */
export type HomeDir =
  | { kind: "pending" }
  | { kind: "ready"; home: string; standIn: boolean }
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
      return { kind: "ready", home: home.data.dir, standIn: home.data.standIn };
    case "unavailable":
      return { kind: "unavailable", message: home.message };
  }
}

/**
 * A crumb's label: "Home" for `~`, the volume's name for `/` (`rootName`,
 * once the computer's volume read has named it; the path itself until then).
 */
export function crumbLabel(path: string, rootName: string | undefined): string {
  if (path === HOME) return "Home";
  if (path === "/") return rootName ?? "/";
  return baseName(path);
}

/** The file system a path bar walks: which one, what `~` is, what it can do. */
export interface PathBarSystem {
  fs: BrowsableFileSystem;
  home: string;
  capabilities: FileSystemCapabilities;
}

/**
 * {@link folderPathSource} bound to this subtree: the live reader its
 * validation reads through, and — on a system with a volume — the name of the
 * volume mounted at `/` ("Macintosh HD") for its crumb, which reads "/" itself
 * until the volume names it, or when it cannot. What every folder path bar
 * renders from (the explorer's toolbar).
 */
export function useFolderPathSource(
  system: PathBarSystem,
  root?: string,
): PathBarSource {
  const rootVolume = useLive(
    computerVolume,
    system.capabilities.volume ? { path: "/" } : null,
  );
  let rootName: string | undefined;
  switch (rootVolume.status) {
    case "ready":
      rootName = rootVolume.data.name;
      break;
    case "loading":
    case "error":
    case "unavailable":
      rootName = undefined;
      break;
  }
  const liveReader = useLiveReader();
  return useMemo(
    () => folderPathSource(liveReader, system, rootName, root),
    [liveReader, system, rootName, root],
  );
}

/**
 * The computer's disk as a path bar, rooted at `root` when given — a file
 * pane's header, drawing a file's place on this computer.
 */
export function useHostPathSource(home: string, root?: string): PathBarSource {
  const system = useMemo<PathBarSystem>(
    () => ({
      fs: "computer",
      home,
      capabilities: FILE_SYSTEMS.computer.capabilities,
    }),
    [home],
  );
  return useFolderPathSource(system, root);
}

/** The folder a typed prefix searches and the fragment it matches, or `null` (not a path). */
function splitPrefix(
  prefix: string,
  home: string,
): { dir: string; fragment: string } | null {
  const abs = absolutePath(prefix, home);
  if (!abs.startsWith("/")) return null;
  const cut = abs.lastIndexOf("/");
  return {
    dir: cut === 0 ? "/" : abs.slice(0, cut),
    fragment: abs.slice(cut + 1),
  };
}

/**
 * A file system as a path-bar source: crumbs from the path itself, folder
 * completions read live (the system's own completions where it has them —
 * the computer's `files.computer.complete` — else the typed folder's listing,
 * its folders matched by name), and validation one stat answer to the commit
 * (`read`, the subtree's `useLiveReader()` — a file resolves to itself, so
 * the explorer opens its folder and previews it). The field spells paths in
 * full — the text it starts from and every completion are absolute — while a
 * resolved path comes back in display form (`~/…` under the system's home),
 * the form the explorer's addresses use.
 *
 * With a `root` (an embedded browser), the bar never leads above it: the
 * crumbs start at the root, completions outside it are dropped, and a typed
 * path outside it is invalid.
 */
export function folderPathSource(
  read: LiveReader,
  system: PathBarSystem,
  rootName: string | undefined,
  root?: string,
): PathBarSource {
  const { fs, home, capabilities } = system;
  const rootAbs = root === undefined ? undefined : absolutePath(root, home);
  const inRoot = (path: string) =>
    rootAbs === undefined || isWithin(absolutePath(path, home), rootAbs);
  const ownCompletions = capabilities.completions;
  return {
    segments: (path) =>
      pathChain(path)
        .filter(inRoot)
        .map((p) => ({
          key: p,
          label: crumbLabel(p, rootName),
          path: p,
        })),
    fieldText: (path) => absolutePath(path, home),
    useComplete: (prefix): Suggestions => {
      const answer = useLive(
        computerFileCompletions,
        ownCompletions && prefix !== null ? { prefix } : null,
      );
      const split =
        ownCompletions || prefix === null ? null : splitPrefix(prefix, home);
      const listing = useFolderListing(fs, split?.dir ?? null).pages;
      if (!ownCompletions) {
        if (prefix === null) return { kind: "pending" };
        if (split === null) return { kind: "ready", items: [] };
        switch (listing.status) {
          case "loading":
            return { kind: "pending" };
          case "unavailable":
            return { kind: "failed", message: listing.message };
          case "error":
            if (
              listing.error.kind === "refused" &&
              (listing.error.code === "missing" ||
                listing.error.code === "not-a-dir")
            ) {
              return { kind: "ready", items: [] };
            }
            return { kind: "failed", message: listing.error.message };
          case "ready": {
            const typed = split.fragment.toLowerCase();
            return {
              kind: "ready",
              items: listing.data
                .filter(
                  (e) =>
                    e.kind === "dir" &&
                    e.name.toLowerCase().startsWith(typed) &&
                    (!e.hidden || typed.startsWith(".")),
                )
                .slice(0, FILE_COMPLETE_LIMIT)
                .map((e) =>
                  split.dir === "/" ? `/${e.name}` : `${split.dir}/${e.name}`,
                )
                .filter(inRoot),
            };
          }
        }
      }
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
              .map((m) => absolutePath(m.path, home)),
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
      const answer = await read(fileStatOf(fs), { path });
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
            case "unsupported":
              return { kind: "invalid", path, reason: answer.message };
          }
      }
    },
  };
}
