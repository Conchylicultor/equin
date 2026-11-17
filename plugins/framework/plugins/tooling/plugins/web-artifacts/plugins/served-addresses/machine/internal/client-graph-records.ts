import { utimes } from "node:fs/promises";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  webGraphRecordPath,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import {
  setClientBuildObserver,
  type Registration,
} from "@plugins/framework/plugins/server-core/core";

// An open tab keeps its own bundle loadable: when a tab's subscription names
// the build graph it runs, this backend touches that graph's record beside the
// namespace's served-dist path (`webGraphRecordPath`) — the namespace's, not
// `webDistDir()`'s: a release backend's WEB_DIST is its own release's dist,
// while the records are one set per namespace, read by the next release's
// publish (`publishReleaseDist`) as by the next dev build. The record's mtime is when the graph was
// last needed, and the build keeps every address a recently needed graph links
// (web-artifacts' address retention) — so a tab used within the window keeps
// loading its lazy plugins, however many builds ago it booted. A tab named by
// nobody within the window (closed, or frozen with its socket down) finds its
// addresses gone and says so: its loads fail loudly, never silently.
//
// Once an hour per graph per process at most — well inside the retention
// window — so a subscription costs a map lookup. A tab reconnects and
// resubscribes on every backend restart, so each build that restarts this
// backend re-reads every connected tab's graph.

const TOUCH_EVERY_MS = 60 * 60 * 1000;

const lastTouched = new Map<string, number>();

function noteClientGraph(graph: string): void {
  const now = Date.now();
  if (now - (lastTouched.get(graph) ?? -Infinity) < TOUCH_EVERY_MS) return;
  lastTouched.set(graph, now);
  const t = new Date(now);
  void runTracked("build.graph-record-touch", () =>
    utimes(
      webGraphRecordPath(worktreeArtifacts.webDist(runtimeNamespace()), graph),
      t,
      t,
    ).catch((err: unknown) => {
      // No record: the graph aged out already (its tab will fail to load
      // what it lacks and offer a reload), or the namespace keeps none.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }),
  );
}

export const clientGraphRecordsRegistration: Registration = {
  register() {
    setClientBuildObserver(noteClientGraph);
  },
};
