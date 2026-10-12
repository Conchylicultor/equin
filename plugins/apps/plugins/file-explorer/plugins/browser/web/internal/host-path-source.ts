import {
  fetchEndpoint,
  useEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import {
  hostFsComplete,
  hostFsStat,
  hostFsVolume,
  isBrowsable,
} from "@plugins/infra/plugins/host-fs/core";
import { hostHome } from "@plugins/infra/plugins/host-account/core";
import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceError } from "@plugins/primitives/plugins/live-state/web";
import type {
  PathBarSource,
  PathResolution,
} from "@plugins/primitives/plugins/path-bar/web";
import {
  absolutePath,
  baseName,
  displayPath,
  HOME,
  isWithin,
  pathChain,
} from "../../core";

/**
 * The user's home directory, absolute — what `~` stands for. Every comparison
 * between a typed path and a listed one goes through it. Read from the
 * backend account's `host-account.home` live value (fixed for the process);
 * pending until it arrives.
 */
export type HomeDir =
  | { kind: "pending" }
  | { kind: "ready"; home: string }
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> };

export function useHomeDir(): HomeDir {
  const home = useLive(hostHome);
  switch (home.status) {
    case "loading":
      return { kind: "pending" };
    case "error":
      return { kind: "failed", error: home.error, refetch: home.refetch };
    case "ready":
      return { kind: "ready", home: home.data };
  }
}

/** The name of the volume mounted at `/` ("Macintosh HD"), once known. */
export function useRootVolumeName(): string | undefined {
  const query = useEndpoint(
    hostFsVolume,
    {},
    { query: { path: "/" }, staleTime: Number.POSITIVE_INFINITY },
  );
  return query.data?.kind === "ok" ? query.data.name : undefined;
}

/** A crumb's label: "Home" for `~`, the volume's name for `/`. */
export function crumbLabel(path: string, rootName: string | undefined): string {
  if (path === HOME) return "Home";
  if (path === "/") return rootName ?? "/";
  return baseName(path);
}

/**
 * The host filesystem as a path-bar source: crumbs from the path itself,
 * folder completions from host-fs `complete`, and validation from `stat` (a
 * file resolves to itself, so the explorer opens its folder and previews it).
 * Paths come back in display form (`~/…` under home).
 *
 * With a `root` (an embedded browser), the bar never leads above it: the
 * crumbs start at the root, completions outside it are dropped, and a typed
 * path outside it is invalid.
 */
export function hostPathSource(
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
    complete: async (prefix) => {
      const result = await fetchEndpoint(
        hostFsComplete,
        {},
        { query: { prefix } },
      );
      switch (result.kind) {
        case "ok":
          return result.matches
            .filter((m) => inRoot(m.path))
            .map((m) => displayPath(m.path, home));
        // Typed into a folder that is not there (or into a file): no folder
        // completes it, which is the answer, not a failure.
        case "missing":
        case "not-a-dir":
          return [];
        case "denied":
          throw new Error(`Permission denied: ${result.path}`);
      }
    },
    validate: async (path): Promise<PathResolution> => {
      const result = await fetchEndpoint(hostFsStat, {}, { query: { path } });
      switch (result.kind) {
        case "ok":
          if (!inRoot(result.path)) {
            return {
              kind: "invalid",
              path,
              reason: `Outside ${displayPath(rootAbs ?? "/", home)}`,
            };
          }
          return {
            kind: isBrowsable(result.entry) ? "dir" : "file",
            path: displayPath(result.path, home),
          };
        case "missing":
          return { kind: "invalid", path, reason: "No such file or folder" };
        case "denied":
          return { kind: "invalid", path, reason: "Permission denied" };
        case "unreadable-archive":
          return {
            kind: "invalid",
            path,
            reason: `Unreadable archive (${result.reason})`,
          };
      }
    },
  };
}
