import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { appPathParent } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  PLUGINS_DIR,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
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
import type { FromWorkerFrame, ToWorkerFrame } from "../../shared/protocol";

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

/** One line per faceted-index build: how long, and whether it resumed. */
const buildLog = defineLogSink({
  id: "plugin-tree",
  description:
    "One line per faceted plugin index build (the faceted-tree worker): its time, and whether it resumed from its checkpoint (how many paths changed since) or started cold (why).",
});

// The checkout the backend serves — the root its watcher reports paths under.
const REPO_ROOT = appPathParent(PLUGINS_DIR);

const WORKER_URL = new URL("../../bin/faceted-tree-worker.ts", import.meta.url);

let sessions = 0;

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
          `faceted index built in ${Math.round(frame.ms)} ms, ${
            frame.start.kind === "resumed"
              ? `resumed from its checkpoint (${frame.start.changed} paths changed since)`
              : `cold (${frame.start.reason})`
          }; steps (ms from its start): ${Object.entries(frame.steps)
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
      case "checkpoint-failed":
        reportServerError({
          message: `[plugin-tree] the faceted index could not leave its checkpoint; the next worker starts from an older one or cold: ${frame.message}`,
        });
        return;
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
        checkpointFile:
          worktreeArtifacts.facetedIndexCheckpoint(runtimeNamespace()),
      } satisfies ToWorkerFrame);
    },
    onMessage: (data) => onFrame(data as FromWorkerFrame),
    onState: (t) => {
      if (t.state === "exited")
        end(`its worker exited (${t.lastError ?? "no error"})`, true);
      else if (t.state === "stopped") end("its worker was stopped", false);
    },
  });

  return {
    tree() {
      if (ended !== null) return Promise.reject(ended);
      if (facetsFailed !== null) return Promise.reject(facetsFailed);
      if (tree !== null) return Promise.resolve(tree);
      return new Promise((resolve, reject) => ready.push({ resolve, reject }));
    },
    structure() {
      if (ended !== null) return Promise.reject(ended);
      if (structure !== null) return Promise.resolve(structure);
      return new Promise((resolve, reject) =>
        structured.push({ resolve, reject }),
      );
    },
    refresh(paths, edited) {
      if (ended !== null) return Promise.reject(ended);
      const id = ++nextId;
      return new Promise<boolean>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        instance.postMessage({
          type: "refresh",
          id,
          paths: [...paths],
          edited: [...edited],
        } satisfies ToWorkerFrame);
      });
    },
    async close() {
      closing = true;
      end("closed", false);
      await instance.stop();
    },
  };
}
