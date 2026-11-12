// The answer trail: where a server stands on one subscription request — the
// evidence a tab attaches when a sub it sent goes unanswered
// (live-state's `unansweredSubReportSink`). Asked over the server's own HTTP
// read route (`GET <resource route>/_answer?…`, `ANSWER_TRAIL_KEY`), so every
// host answers it the same way — the worktree server, central, and a browser
// host in a worker, which has no runtime profile of its own (no loader spans,
// no `wait read-admit` with holders): the trail is that split, kept by the
// runtime itself.
//
// Every instant is the server's wall clock (`Date.now()`). The tab and its
// servers run on one machine, so the tab sets them against its own send and
// ask instants: how long the frame took to be READ (a server thread busy, a
// port queue), how long it queued for a read slot (and behind whom), how long
// its load has run, and whether an answer left at all.

/** The reserved key the answer trail is read at, beside the resource keys. */
export const ANSWER_TRAIL_KEY = "_answer";

/** Its query: which request (`tabId` + `id`, as the sub frame named them) and tuple. */
export interface AnswerTrailQuery {
  tabId: string;
  id: number;
  key: string;
  /** The tuple's params, as the sub sent them (JSON object of strings). */
  params: Record<string, string>;
}

/** The answer frames that settle a request — what the tab stops waiting on. */
export type AnswerFrameKind = "sub-ack" | "up-to-date" | "sub-error";

/**
 * The request itself:
 * - `no-record` — the server never read the frame (it is still queued on its
 *   way in — a busy server thread — or was lost), or answered it so long ago
 *   its record is gone (`ANSWER_RECORD_KEEP_MS`, far past any deadline);
 * - `received` — read at `at`, no answer sent yet;
 * - `answered` — read at `receivedAt`, its answer (`frame`) sent at `at`: the
 *   answer was lost or is still on its way back to the tab.
 */
export type AnswerTrailRequest =
  | { kind: "no-record" }
  | { kind: "received"; at: number }
  | {
      kind: "answered";
      receivedAt: number;
      at: number;
      frame: AnswerFrameKind;
    };

/** One read holding a read-admission slot (the gate's `holders`). */
export interface AnswerTrailHolder {
  label: string;
  heldMs: number;
}

/** The longest list of gate holders a trail carries (the longest-held first). */
export const ANSWER_TRAIL_HOLDERS_MAX = 6;

export interface AnswerTrail {
  /** When the server answered this question — set against the ask, its own thread's delay. */
  at: number;
  request: AnswerTrailRequest;
  /**
   * The tuple's reads waiting for a read-admission slot now: since when (the
   * oldest), and whether the oldest is a `revalidate` signature probe. Null
   * when none waits.
   */
  queued: { since: number; probe: boolean } | null;
  /** The tuple's loads running now: since when (the oldest). Null when none runs. */
  loading: { since: number } | null;
  /** The read-admission gate as it stands: its occupancy and who holds it. */
  gate: {
    active: number;
    queued: number;
    max: number;
    holders: AnswerTrailHolder[];
  };
}

function fail(what: string, raw: unknown): never {
  throw new Error(
    `[resource-protocol] malformed answer trail (${what}): ${JSON.stringify(raw)?.slice(0, 300)}`,
  );
}

function num(raw: unknown, what: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) fail(what, raw);
  return raw;
}

function obj(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(what, raw);
  }
  return raw as Record<string, unknown>;
}

const ANSWER_FRAMES: ReadonlySet<string> = new Set<AnswerFrameKind>([
  "sub-ack",
  "up-to-date",
  "sub-error",
]);

function parseRequest(raw: unknown): AnswerTrailRequest {
  const r = obj(raw, "request");
  switch (r.kind) {
    case "no-record":
      return { kind: "no-record" };
    case "received":
      return { kind: "received", at: num(r.at, "request.at") };
    case "answered":
      if (typeof r.frame !== "string" || !ANSWER_FRAMES.has(r.frame)) {
        fail("request.frame", r.frame);
      }
      return {
        kind: "answered",
        receivedAt: num(r.receivedAt, "request.receivedAt"),
        at: num(r.at, "request.at"),
        frame: r.frame as AnswerFrameKind,
      };
    default:
      return fail("request.kind", r.kind);
  }
}

/** Read a trail body; throws naming the field on anything else. */
export function parseAnswerTrail(raw: unknown): AnswerTrail {
  const t = obj(raw, "body");
  const gate = obj(t.gate, "gate");
  if (!Array.isArray(gate.holders)) fail("gate.holders", gate.holders);
  const queued =
    t.queued === null
      ? null
      : (() => {
          const q = obj(t.queued, "queued");
          if (typeof q.probe !== "boolean") fail("queued.probe", q.probe);
          return { since: num(q.since, "queued.since"), probe: q.probe };
        })();
  const loading =
    t.loading === null
      ? null
      : { since: num(obj(t.loading, "loading").since, "loading.since") };
  return {
    at: num(t.at, "at"),
    request: parseRequest(t.request),
    queued,
    loading,
    gate: {
      active: num(gate.active, "gate.active"),
      queued: num(gate.queued, "gate.queued"),
      max: num(gate.max, "gate.max"),
      holders: (gate.holders as unknown[]).map((h) => {
        const o = obj(h, "gate.holders[]");
        if (typeof o.label !== "string") fail("holder.label", o.label);
        return { label: o.label, heldMs: num(o.heldMs, "holder.heldMs") };
      }),
    },
  };
}
