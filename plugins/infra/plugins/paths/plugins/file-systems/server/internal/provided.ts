import {
  defineServerContribution,
  type ServerContribution,
} from "@plugins/framework/plugins/server-core/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import { fileSystemsServed, type FileSystemKind } from "../../core";

const providedToken = defineServerContribution<{ fs: FileSystemKind }>(
  "file-systems.provided",
  { docLabel: (p) => p.fs },
);

/**
 * This host serves file system `fs`: contributed by the half that serves its
 * reads (host-fs's machine half for the computer's disk, the in-browser store
 * for the browser's storage), so `files.systems` lists exactly the systems
 * someone answers here.
 */
export function FileSystemProvided(fs: FileSystemKind): ServerContribution {
  return providedToken({ fs });
}

/** The file systems this host serves, each once, in the closed set's order. */
export const fileSystemsServedServed = serveValue(fileSystemsServed, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "providers are contributed by the plugins this host booted; the set changes only with a build",
    },
  },
  loader: () => {
    const provided = providedToken.getContributions().map((p) => p.fs);
    for (const fs of provided) {
      if (provided.indexOf(fs) !== provided.lastIndexOf(fs)) {
        throw new Error(
          `[file-systems] file system "${fs}" is provided twice on this host`,
        );
      }
    }
    return (["computer", "browser", "checkout"] as const).filter((fs) =>
      provided.includes(fs),
    );
  },
});
