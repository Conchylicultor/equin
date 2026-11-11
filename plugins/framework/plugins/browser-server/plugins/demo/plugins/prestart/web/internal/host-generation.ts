import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";

// Which SharedWorker the demo's tabs share: the scenario's host generation,
// part of the worker's name. A Reset ends the host and its worker closes
// itself, but Chromium matches a `new SharedWorker(url, name)` against the
// worker until the browser process has heard of its close: a tab that
// reconnects at once under the same name (every tab does, on `ended:
// "reset"`) can be handed the dying worker, which never answers — the tab
// waits on Loading for good. So a Reset (or a retiring worker, skipped) moves
// every tab to the NEXT generation's name, and a name moved past is never
// asked for again: moving on always reaches a name no tab used (`highest` + 1),
// so it can never land on a worker that is closing — or one that just
// declined, telling its tab to join another (`joinHostGeneration`).
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
  schema: z.object({
    /** The generation tabs connect to now. */
    current: z.number().int().nonnegative(),
    /** The highest generation any tab ever used: the next fresh name is past it. */
    highest: z.number().int().nonnegative(),
  }),
});

function read(scenarioId: string): { current: number; highest: number } {
  const stored = generationStore.read(scenarioId);
  return stored.kind === "value" ? stored.value : { current: 0, highest: 0 };
}

/** The generation a tab of `scenarioId` connects to now. */
export function hostGeneration(scenarioId: string): number {
  return read(scenarioId).current;
}

/**
 * Past `from` (the generation a Reset ends, or a retiring worker's): the
 * generation the tabs already moved to when one did — so every tab told the
 * same host ended agrees on the next name, whichever writes first — else a
 * fresh one, past every generation any tab used. Called before a Reset is
 * sent — so a tab opened while the host wipes already asks for the next
 * worker, never the closing one — and by every tab told the host ended.
 */
export function advanceHostGeneration(
  scenarioId: string,
  from: number,
): number {
  const { current, highest } = read(scenarioId);
  const next = current > from ? current : Math.max(highest, from) + 1;
  // A refused write is reported by the store (`onStorageFailure`); this tab
  // still moves on, and a tab opened later may start another generation's
  // worker — which, the same host, is told to join this one.
  generationStore.write(scenarioId, {
    current: next,
    highest: Math.max(highest, next),
  });
  return next;
}

/**
 * Back to `generation`, whose worker serves the scenario's storage now (a
 * worker this tab reached declined, telling it to join that one): tabs
 * connect to it from now on. It stays below `highest`, so moving past it
 * still reaches a fresh name.
 */
export function joinHostGeneration(
  scenarioId: string,
  generation: number,
): void {
  const { highest } = read(scenarioId);
  generationStore.write(scenarioId, {
    current: generation,
    highest: Math.max(highest, generation),
  });
}

/** The SharedWorker name of `scenarioId`'s host at `generation`. */
export function hostWorkerName(scenarioId: string, generation: number): string {
  return generation === 0 ? scenarioId : `${scenarioId}@${generation}`;
}

/** The generation a worker of `scenarioId` is named for (`hostWorkerName`'s inverse); throws on another name. */
export function generationOfWorker(scenarioId: string, worker: string): number {
  if (worker === scenarioId) return 0;
  const prefix = `${scenarioId}@`;
  const generation = worker.startsWith(prefix)
    ? Number(worker.slice(prefix.length))
    : Number.NaN;
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error(
      `[demo/prestart] "${worker}" is not a worker name of the scenario "${scenarioId}"`,
    );
  }
  return generation;
}

/** One scope's view of its host's generations (`trackHostGenerations`). */
export interface HostGenerations {
  /** The generation to connect to now — read at the moment of connecting. */
  current(): number;
  /** Past `from` (a Reset ends it, or its worker is retiring): this tab never asks for it again. */
  advance(from: number): void;
  /**
   * To the generation of `worker` — a worker of this scenario serving its
   * storage now, which a declining worker told this tab to join
   * (`joinHostGeneration`). Returns that generation.
   */
  join(worker: string): number;
}

/**
 * The generations of `scenarioId`'s host as one tab sees them: what
 * localStorage says, never below what this tab last moved to — so a store
 * that cannot be read or written (reported by the store) does not send this
 * tab back to a closed worker's name.
 */
export function trackHostGenerations(scenarioId: string): HostGenerations {
  let floor = 0;
  /**
   * The stored generation this tab joined away from: while the store still
   * says it (its write refused), this tab stays on the one it joined — never
   * back to the worker that sent it away, round and round.
   */
  let joinedOver: number | null = null;
  return {
    current: () => {
      const stored = hostGeneration(scenarioId);
      if (joinedOver !== null && stored === joinedOver) return floor;
      joinedOver = null;
      return Math.max(floor, stored);
    },
    advance(from) {
      joinedOver = null;
      floor = Math.max(floor, advanceHostGeneration(scenarioId, from));
    },
    join(worker) {
      const generation = generationOfWorker(scenarioId, worker);
      const stored = hostGeneration(scenarioId);
      joinHostGeneration(scenarioId, generation);
      joinedOver = stored === generation ? null : stored;
      floor = generation;
      return generation;
    },
  };
}
