import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { appPathParent } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { defineDaemon } from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import {
  pluginTreeFromDelta,
  type PluginTreeData,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  FacetedSessionEnded,
  FacetsUnavailable,
  type FacetedSessionHandlers,
  type FacetedTreeSession,
} from "@plugins/plugin-meta/plugins/plugin-tree/server";
import {
  readFromWorkerFrame,
  type FromWorkerFrame,
  type ToWorkerFrame,
} from "../../shared/protocol";

/**
 * The faceted-tree worker, declared once. On demand (the first faceted read
 * of a process starts it) and never respawned by the supervisor: its state is
 * the index, so a new incarnation is a new session, which the backend opens on
 * its next read. Its code is build tooling loaded by a computed path — no
 * digest can vouch for it — and it holds only what that code rebuilds, so a
 * restart-skip stops it rather than judge it (`onCodeAdopted: "stop"`).
 */
export const facetedTreeDaemon = defineDaemon({
  name: "plugin-tree.faceted-index",
  description:
    "Holds this checkout's plugin trees — the structure (every plugin, its key-file fields) and the faceted tree (every plugin's facets, related) — and keeps them up to date by the files the watcher saw change, so plugin views, Studio, the composition graph and the deploy-secrets gate read them without the backend building either.",
  startedBy: "on-demand",
  where: "every-worktree",
  restart: { kind: "never" },
  onCodeAdopted: "stop",
});

/** One line per faceted-index build: how long, and each step's end. */
const buildLog = defineLogSink({
  id: "plugin-tree",
  description:
    "One line per faceted plugin index build (the faceted-tree worker): its time, and when each of its steps ended.",
});

// The checkout the backend serves — the root its watcher reports paths under.
const REPO_ROOT = appPathParent(PLUGINS_DIR);

const WORKER_URL = new URL("../../bin/faceted-tree-worker.ts", import.meta.url);

let sessions = 0;

/**
 * Set once a worker's frame did not match this backend's protocol: the
 * worker runs the checkout's code, which moved since this backend started
 * (`shared/protocol.ts`). Another worker would load the same code, so none is
 * spawned again: every session opened after it is refused with this reason,
 * until the backend restarts on the checkout's code (main's deploy, a
 * worktree's build).
 */
let protocolSkew: FacetedSessionEnded | null = null;

interface Waiter<T> {
  resolve(value: T): void;
  reject(err: Error): void;
}

/**
 * Start a worker and its session. The worker handles frames in order, so a
 * refresh posted before the cold build is done is applied after it, and the
 * replies come back in the order they were asked.
 */
export function openFacetedTreeSession({
  onEnded,
  onStructureChanged,
}: FacetedSessionHandlers): FacetedTreeSession {
  if (protocolSkew !== null) return refusedSession(protocolSkew);
  let tree: PluginTreeData | null = null;
  /** Why the facets are failed (the structure lives on), or null. */
  let facetsFailed: FacetsUnavailable | null = null;
  let structure: PluginTreeData | null = null;
  let ended: FacetedSessionEnded | null = null;
  let closing = false;
  let nextId = 0;
  const ready: Waiter<PluginTreeData>[] = [];
  const structured: Waiter<PluginTreeData>[] = [];
  const pending = new Map<number, Waiter<boolean>>();
  // The cold build is ONE run of the worker, however many reads wait for it.
  // The first read of each tree awaits the worker (`awaitReply`: the
  // `worker:<daemon>` io wait, filed as `wait worker:plugin-tree.faceted-index`
  // when slow); every read arriving while it is in flight joins that read
  // (`inflight:plugin-tree.cold-build`, a join: the build's time, reported by
  // its first waiter). Before, each waiter filed the same build again — on
  // main the warm-up and the session's own first-build span both waited on
  // every restart's build, so one 2.3 s build was two reports' occurrences.
  const coldBuild = createInflight("plugin-tree.cold-build");

  /** End the session; `failed` when it ended on an error, not by design. */
  const end = (reason: string, failed: boolean): void => {
    if (ended !== null) return;
    ended = new FacetedSessionEnded(reason, failed);
    for (const w of ready.splice(0)) w.reject(ended);
    for (const w of structured.splice(0)) w.reject(ended);
    for (const w of pending.values()) w.reject(ended);
    pending.clear();
    if (!closing) {
      // The instance stays claimed until stopped (`restart: never`).
      void runTracked("plugin-tree:faceted-worker-stop", () => instance.stop());
      onEnded(ended, {
        structure: structure !== null,
        facets: tree !== null || facetsFailed !== null,
      });
    }
  };

  // A waiter leaves `ready` / `pending` only once settled, so ending the
  // session — by a frame or by a throw while applying one — rejects it.
  const applyFrame = (frame: FromWorkerFrame): void => {
    switch (frame.type) {
      case "structure": {
        const first = structure === null;
        structure = pluginTreeFromDelta(PLUGINS_DIR, frame.delta, null);
        if (first) for (const w of structured.splice(0)) w.resolve(structure);
        else onStructureChanged();
        return;
      }
      case "ready":
        buildLog.publish(
          `faceted index built in ${Math.round(frame.ms)} ms; steps (ms from its start): ${Object.entries(
            frame.steps,
          )
            .map(([step, ms]) => `${step} ${ms}`)
            .join(", ")}`,
        );
        if (frame.facets.kind === "failed") {
          facetsFailed = new FacetsUnavailable(frame.facets.message);
          reportServerError({ message: facetsFailed.message });
          for (const w of ready.splice(0)) w.reject(facetsFailed);
          return;
        }
        tree = pluginTreeFromDelta(PLUGINS_DIR, frame.facets.delta, null);
        for (const w of ready.splice(0)) w.resolve(tree);
        return;
      case "refreshed": {
        const { result } = frame;
        if (result.kind === "code-changed") {
          // Built by code no longer on disk: a fresh worker loads the new.
          end(`its code changed (${result.path})`, false);
          return;
        }
        if (result.kind === "facets-retry") {
          // Its facets failed and something changed: a fresh worker
          // imports the facet modules anew and builds them again.
          end("its facets failed and the checkout changed since", false);
          return;
        }
        let moved = false;
        if (result.kind === "changed") {
          // After a failure the delta holds every node's facets.
          tree = pluginTreeFromDelta(PLUGINS_DIR, result.delta, tree);
          facetsFailed = null;
          moved = true;
        } else if (result.kind === "facets-failed") {
          // Readers were handed a tree (or no failure yet): theirs moved.
          moved = facetsFailed === null;
          facetsFailed = new FacetsUnavailable(result.message);
          if (moved) reportServerError({ message: facetsFailed.message });
          tree = null;
        }
        const w = pending.get(frame.id);
        pending.delete(frame.id);
        w?.resolve(moved);
        return;
      }
      case "failed":
        end(frame.message, true);
        return;
    }
  };
  const onFrame = (frame: FromWorkerFrame): void => {
    try {
      applyFrame(frame);
    } catch (err) {
      // The held tree and the worker's disagree (or a frame is malformed):
      // nothing it holds can be trusted.
      end(
        `a ${frame.type} frame could not be applied: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  };

  const instance = facetedTreeDaemon.spawnWorker({
    instance: `session ${++sessions}`,
    url: WORKER_URL,
    onSpawn: (worker) => {
      worker.postMessage({
        type: "init",
        root: REPO_ROOT,
      } satisfies ToWorkerFrame);
    },
    onMessage: (data) => {
      const read = readFromWorkerFrame(data);
      if (read.ok) return onFrame(read.frame);
      protocolSkew = new FacetedSessionEnded(
        `the faceted-tree worker runs other code than this backend — the checkout moved since the backend started; reads are refused until it restarts on the checkout's code: ${read.issue}`,
        true,
      );
      end(protocolSkew.message, true);
    },
    onState: (t) => {
      if (t.state === "exited")
        end(`its worker exited (${t.lastError ?? "no error"})`, true);
      else if (t.state === "stopped") end("its worker was stopped", false);
    },
  });

  return {
    // Every answer still to come is the worker's (its build, its refresh):
    // awaited through `awaitReply`, so the reader's span shows it as a
    // `worker:plugin-tree.faceted-index` wait, not as its own time — the
    // cold build's by its first reader only, the rest joining it (above).
    tree() {
      if (ended !== null) return Promise.reject(ended);
      if (facetsFailed !== null) return Promise.reject(facetsFailed);
      if (tree !== null) return Promise.resolve(tree);
      return coldBuild.run("facets", () =>
        instance.awaitReply(
          new Promise<PluginTreeData>((resolve, reject) =>
            ready.push({ resolve, reject }),
          ),
        ),
      );
    },
    structure() {
      if (ended !== null) return Promise.reject(ended);
      if (structure !== null) return Promise.resolve(structure);
      return coldBuild.run("structure", () =>
        instance.awaitReply(
          new Promise<PluginTreeData>((resolve, reject) =>
            structured.push({ resolve, reject }),
          ),
        ),
      );
    },
    refresh(paths, edited) {
      if (ended !== null) return Promise.reject(ended);
      const id = ++nextId;
      return instance.awaitReply(
        new Promise<boolean>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          instance.postMessage({
            type: "refresh",
            id,
            paths: [...paths],
            edited: [...edited],
          } satisfies ToWorkerFrame);
        }),
      );
    },
    async close() {
      closing = true;
      end("closed", false);
      await instance.stop();
    },
  };
}

/**
 * A session that never started: every read rejects with `reason`, and a
 * watcher batch moves nothing (there is no tree to bring up to date — a
 * rejecting refresh would drop it and bump every reader into the same
 * refusal on each batch).
 */
function refusedSession(reason: FacetedSessionEnded): FacetedTreeSession {
  return {
    tree: () => Promise.reject(reason),
    structure: () => Promise.reject(reason),
    refresh: () => Promise.resolve(false),
    close: async () => {},
  };
}
