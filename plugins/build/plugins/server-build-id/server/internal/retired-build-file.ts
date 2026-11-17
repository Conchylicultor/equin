import { webDistDir } from "@plugins/infra/plugins/paths/server";
import {
  webGraphRecordPath,
  webGraphRecordsDir,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { exists } from "@plugins/packages/plugins/timed-fs/core";
import { getServerGraphHash } from "./get-server-graph-hash";

// Whether a file a tab's build needed is gone BECAUSE that build was retired —
// the server's half of the proof that version skew explains a failed load
// (reports/core's version-skew). The tab names the file it got a 404 for; this
// re-checks both facts against what this backend serves, trusting neither
// alone:
//
// 1. The file is not served: `<dist>/artifacts/<name>` (the namespace's
//    address dir, which the gateway serves `/artifacts/*` from) holds no such
//    entry — or only a link whose target is gone, which the gateway 404s too.
// 2. The tab's build graph was RETIRED: the namespace keeps graph records (so
//    it retires graphs at all) and this graph has none
//    (web-artifacts' address retention drops a graph's record when no tab
//    named it within the window, and only then lets its addresses go). A
//    graph still recorded keeps every address it links, so a 404 for one of
//    them is a bug of the retention or the store, never skew.
//
// The served graph is never retired, whatever the records say.
//
// The records are the NAMESPACE's (beside `worktreeArtifacts.webDist`), not
// beside `webDistDir()`: on a release host the backend's dist is its own
// release's (`web.live.<runId>`), while one set of records serves every
// release of the namespace (web-artifacts' `served-addresses`). On a dev host
// the two paths are the same.

/** The address-dir name of an `/artifacts/<name>/<file>` path, or null. */
function artifactNameOf(path: string): string | null {
  const m = /^\/artifacts\/([^/]+)\/./.exec(path);
  const name = m?.[1];
  if (name === undefined || name === "." || name === "..") return null;
  return name;
}

/** {@link isRetiredBuildFile} against an explicit dist (test seam). */
export async function isRetiredBuildFileIn(
  distDir: string,
  recordsAnchor: string,
  servedGraph: string | null,
  occurrence: { graph: string | null | undefined; path: string },
): Promise<boolean> {
  const { graph, path } = occurrence;
  if (graph == null || graph === servedGraph) return false;
  // A graph id is a hash; anything else never names a record.
  if (!/^[A-Za-z0-9_-]+$/.test(graph)) return false;
  const name = artifactNameOf(path);
  if (name === null) return false;
  if (await exists(`${distDir}/artifacts/${name}`)) return false;
  if (!(await exists(webGraphRecordsDir(recordsAnchor)))) return false;
  return !(await exists(webGraphRecordPath(recordsAnchor, graph)));
}

/**
 * Whether `path` (an `/artifacts/<name>/<file>` URL path a tab of build graph
 * `graph` got a 404 for) is a file this backend's namespace no longer serves
 * because it retired that graph. False for anything it cannot prove.
 */
export async function isRetiredBuildFile(occurrence: {
  graph: string | null | undefined;
  path: string;
}): Promise<boolean> {
  return await isRetiredBuildFileIn(
    webDistDir(),
    worktreeArtifacts.webDist(runtimeNamespace()),
    await getServerGraphHash(),
    occurrence,
  );
}
