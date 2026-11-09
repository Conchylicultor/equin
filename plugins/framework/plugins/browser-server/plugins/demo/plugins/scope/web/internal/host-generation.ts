import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";

// Which SharedWorker the demo's tabs share: the scenario's host generation,
// part of the worker's name. A Reset ends the host and its worker closes
// itself, but Chromium matches a `new SharedWorker(url, name)` against the
// worker until the browser process has heard of its close: a tab that
// reconnects at once under the same name (every tab does, on `ended:
// "reset"`) can be handed the dying worker, which never answers — the tab
// waits on Loading for good. So a Reset moves every tab to the NEXT
// generation's name, and a closed worker's name is never asked for again.
// Kept page-wide in localStorage: a tab opened later connects to the
// generation the others are on.
const generationStore = defineStore({
  owner: "demo-scope.host-generation",
  pageWide: {
    reason:
      "which worker the page's tabs share — read outside the scope it serves",
  },
  label: "Demo host generations",
  area: "local",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.number().int().nonnegative(),
});

/** The generation a tab of `scenarioId` connects to now. */
export function hostGeneration(scenarioId: string): number {
  const read = generationStore.read(scenarioId);
  return read.kind === "value" ? read.value : 0;
}

/**
 * Past `from` (the generation a Reset ends): the next one, never back. Called
 * before the Reset is sent — so a tab opened while the host wipes already
 * asks for the next worker, never the closing one — and by every tab told the
 * host ended, so each reconnects to the next one whatever this tab's copy of
 * localStorage has seen yet.
 */
export function advanceHostGeneration(
  scenarioId: string,
  from: number,
): number {
  const next = Math.max(hostGeneration(scenarioId), from + 1);
  // A refused write is reported by the store (`onStorageFailure`); this tab
  // still moves on, and a tab opened later starts an older generation's
  // worker, which claims the storage (one owner at a time) and the others
  // show why, with Reload — never a closed worker's silence.
  generationStore.write(scenarioId, next);
  return next;
}

/** The SharedWorker name of `scenarioId`'s host at `generation`. */
export function hostWorkerName(scenarioId: string, generation: number): string {
  return generation === 0 ? scenarioId : `${scenarioId}@${generation}`;
}

/** One scope's view of its host's generations (`trackHostGenerations`). */
export interface HostGenerations {
  /** The generation to connect to now — read at the moment of connecting. */
  current(): number;
  /** Past `from` (a Reset ends it): this tab never asks for it again. */
  advance(from: number): void;
}

/**
 * The generations of `scenarioId`'s host as one tab sees them: what
 * localStorage says, never below what this tab already moved past — so a
 * store that cannot be read or written (reported by the store) does not send
 * this tab back to a closed worker's name.
 */
export function trackHostGenerations(scenarioId: string): HostGenerations {
  let floor = 0;
  return {
    current: () => Math.max(floor, hostGeneration(scenarioId)),
    advance(from) {
      floor = Math.max(floor, advanceHostGeneration(scenarioId, from));
    },
  };
}
