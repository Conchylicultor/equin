// What the runtime keeps to answer "where is this subscription request?"
// (resource-protocol's answer trail): each request it read, until and shortly
// after it answered, and the reads of each tuple waiting for a read-admission
// slot or running their load. Plain state, kept by the runtime itself on every
// host — a browser host has no profiler to split a wait with, and needs none
// for this.
//
// Bounded: a request is recorded while it is owed an answer (at most
// `OWED_RECORD_KEEP_MS` — one never answered because its socket closed or its
// read was abandoned is forgotten then), plus `ANSWER_RECORD_KEEP_MS` after
// its answer (a tab asks at its deadline, 15 s after the send); at most
// `ANSWER_RECORDS_MAX` of each kind, the oldest going first.

import type {
  AnswerFrameKind,
  AnswerTrailRequest,
} from "@plugins/network/plugins/live/plugins/resource-protocol/core";

/** How long an answered request's record is kept: well past any tab's deadline. */
export const ANSWER_RECORD_KEEP_MS = 120_000;

/** How long a request still owed an answer is kept (far past any deadline a tab judges). */
export const OWED_RECORD_KEEP_MS = 600_000;

/** The most records of each kind kept at once (a restart's replay herd fits several times). */
export const ANSWER_RECORDS_MAX = 20_000;

type RequestRecord =
  | { kind: "received"; at: number }
  | {
      kind: "answered";
      receivedAt: number;
      at: number;
      frame: AnswerFrameKind;
    };

/** One stage a tuple's read is in: since when, and whether it is a signature probe. */
export interface StageToken {
  since: number;
  probe: boolean;
}

export interface AnswerLedger {
  /** A request (`tabId` + `id`) was read at `at`. */
  received(tabId: string, id: number, at: number): void;
  /** An answer frame for it was sent at `at`; a request never read is ignored. */
  answered(tabId: string, id: number, frame: AnswerFrameKind, at: number): void;
  request(tabId: string, id: number): AnswerTrailRequest;
  /** A read of `tuple` entered `stage`; returns its leave. */
  enter(
    stage: "queued" | "loading",
    tuple: string,
    token: StageToken,
  ): () => void;
  /** The oldest read of `tuple` in `stage` now, or null. */
  oldest(stage: "queued" | "loading", tuple: string): StageToken | null;
}

export function createAnswerLedger(now: () => number): AnswerLedger {
  const owed = new Map<string, RequestRecord & { kind: "received" }>();
  const done = new Map<string, RequestRecord & { kind: "answered" }>();
  const stages = {
    queued: new Map<string, Set<StageToken>>(),
    loading: new Map<string, Set<StageToken>>(),
  };
  const idOf = (tabId: string, id: number) => `${tabId}\0${id}`;

  // Both maps are in insertion order — receipt for `owed`, answer for
  // `done` — so the front is the oldest and a prune stops at the first keeper.
  function prune(map: Map<string, { at: number }>, keepMs: number): void {
    const floor = now() - keepMs;
    for (const [k, r] of map) {
      if (r.at >= floor && map.size <= ANSWER_RECORDS_MAX) break;
      map.delete(k);
    }
  }

  return {
    received(tabId, id, at) {
      const k = idOf(tabId, id);
      done.delete(k);
      owed.delete(k);
      owed.set(k, { kind: "received", at });
      prune(owed, OWED_RECORD_KEEP_MS);
    },
    answered(tabId, id, frame, at) {
      const k = idOf(tabId, id);
      const rec = owed.get(k);
      if (rec === undefined) return;
      owed.delete(k);
      done.set(k, { kind: "answered", receivedAt: rec.at, at, frame });
      prune(done, ANSWER_RECORD_KEEP_MS);
    },
    request(tabId, id) {
      const k = idOf(tabId, id);
      return owed.get(k) ?? done.get(k) ?? { kind: "no-record" };
    },
    enter(stage, tuple, token) {
      const map = stages[stage];
      let set = map.get(tuple);
      if (set === undefined) map.set(tuple, (set = new Set()));
      set.add(token);
      let left = false;
      return () => {
        if (left) return;
        left = true;
        set.delete(token);
        if (set.size === 0 && map.get(tuple) === set) map.delete(tuple);
      };
    },
    oldest(stage, tuple) {
      let best: StageToken | null = null;
      for (const t of stages[stage].get(tuple) ?? []) {
        if (best === null || t.since < best.since) best = t;
      }
      return best;
    },
  };
}
