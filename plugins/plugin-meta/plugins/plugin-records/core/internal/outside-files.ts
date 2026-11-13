import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { sharedMemo } from "@plugins/packages/plugins/shared-work/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { OutsideFiles } from "./module-graph";

/**
 * The files outside a file set (gitignored), read from its checkout when the
 * module graph asks for one: its content, or null when no file is there.
 * Asynchronous, so a graph grown on a backend (the faceted tree a review
 * builds) holds no thread on the disk.
 *
 * ONE READER PER SET. Graphs over one set share a walk only when they share
 * the reader (`buildModuleGraph` keys its graph by the reader's identity), so
 * every caller over the same set gets the same function: a check pass's
 * barrel-free tree, its two barrel evaluations, its enriched tree and its
 * file scans grow ONE graph. A fresh reader per call made each of them walk
 * the closures again — the all-runtime evaluation re-walked every web
 * barrel's closure the web evaluation had just walked. A writing pass that
 * writes generated files re-takes its set per phase (`CodegenPass.phaseRepo`),
 * so a phase's graph never holds what an earlier phase read off the disk.
 */
export const outsideFilesOf: (repo: RepoFiles) => OutsideFiles = sharedMemo(
  "outside files",
  (repo: RepoFiles): OutsideFiles =>
    async (rel) => {
      try {
        return await readFile(joinAppPath(repo.root, rel), "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") {
          return null;
        }
        throw err;
      }
    },
);
