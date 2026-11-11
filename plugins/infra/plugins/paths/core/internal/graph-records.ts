// A served namespace's GRAPH RECORDS: one file per web graph (the composed
// bundle's content identity, `.build-graph`) its dists have served, listing the
// address-dir names a tab of that graph can fetch. The file's mtime is when the
// graph was last needed — composed or served by a build, or named by an open
// tab (the backend touches it). A build keeps an address in the namespace's
// address dir only while some graph needing it was needed recently
// (web-artifacts' `cli/` address-dir retention).
//
// One spelling for the two writers: the build (which writes and reads them) and
// the backend (which only touches one when a tab names its graph).

/** The graph-records dir of the served dist at `distDir` (`<dist>-graphs`). */
export function webGraphRecordsDir(distDir: string): string {
  return `${distDir}-graphs`;
}

/** The record of `graph` among the served dist's graph records. */
export function webGraphRecordPath(distDir: string, graph: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(graph)) {
    throw new Error(
      `webGraphRecordPath: "${graph}" is not a graph hash (a record path must stay inside its dir)`,
    );
  }
  return `${webGraphRecordsDir(distDir)}/${graph}.names`;
}
