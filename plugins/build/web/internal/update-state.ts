// The page's update state outside React: the two flags `UpdatePolicyRoot`
// derives over time (overdue, blocked) and the Update pill reads, and the
// record an update reload leaves for the page it loads.

import { useSyncExternalStore } from "react";
import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { flushKept } from "@plugins/primitives/plugins/kept-state/web";
import { quietReload } from "@plugins/primitives/plugins/dom/plugins/reload-readiness/web";

export interface UpdateFlags {
  /** A pending update has waited longer than `UPDATE_OVERDUE_MS` for its moment. */
  overdue: boolean;
  /** An update reload already came back behind on the same target: no auto-reload. */
  blocked: boolean;
}

const NO_FLAGS: UpdateFlags = { overdue: false, blocked: false };

/* eslint-disable scoped-store/no-module-mutable-store -- page-global by design: there is one page to reload, and its update state is a fact about the whole page shared by every surface (the policy root writes it once per page, the Update pill in every action bar reads it) — a per-surface store would let two bars disagree about one reload. */
let flags: UpdateFlags = NO_FLAGS;
/* eslint-enable scoped-store/no-module-mutable-store */
const listeners = new Set<() => void>();

export function setUpdateFlags(next: UpdateFlags): void {
  if (next.overdue === flags.overdue && next.blocked === flags.blocked) return;
  flags = next;
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUpdateFlags(): UpdateFlags {
  return useSyncExternalStore(
    subscribe,
    () => flags,
    () => flags,
  );
}

// ── the update reload's record, for the page it loads ──────────────────────

const updateReloadStore = defineStore({
  owner: "build.update-reload",
  pageWide: { reason: "the page's own reload into a newer build" },
  label: "Update reload in progress",
  area: "session",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.object({
    /** The served graph the reload moved to (null: only refusals said so). */
    target: z.string().nullable(),
    /** The page was on screen: the new page says "Updated". */
    visible: z.boolean(),
  }),
});

/** What the update reload that loaded this page left: read once, then removed. */
export type UpdateArrival = { target: string | null; visible: boolean } | null;

// Page-global: the record is consumed once per page load, by whichever reader
// comes first.
let arrival: UpdateArrival | undefined;

export function updateArrival(): UpdateArrival {
  if (arrival !== undefined) return arrival;
  const read = updateReloadStore.read();
  arrival = read.kind === "value" ? read.value : null;
  if (arrival !== null) updateReloadStore.remove("");
  return arrival;
}

function recordUpdateReload(target: string | null, visible: boolean): void {
  updateReloadStore.write("", { target, visible });
}

/** The policy's reload: lossless, after every hold has released. */
export function quietUpdate(target: string | null, visible: boolean): void {
  recordUpdateReload(target, visible);
  void quietReload();
}

/**
 * The user asked for it (the pill): reload at once, even over a running
 * process — they chose to stop it. Kept state is flushed first, so nothing
 * the user made is lost.
 */
export function updateNow(target: string | null): void {
  recordUpdateReload(target, true);
  flushKept();
  window.location.reload();
}

/** The fault pill's retry: a plain reload, flushed, recording no update. */
export function retryLoad(): void {
  flushKept();
  window.location.reload();
}

/** Back to the initial state, for this plugin's own tests only. */
export function resetUpdateState(): void {
  flags = NO_FLAGS;
  arrival = undefined;
  updateReloadStore.remove("");
}
