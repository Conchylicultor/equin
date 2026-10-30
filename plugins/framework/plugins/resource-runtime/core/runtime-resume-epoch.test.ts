/**
 * The epoch handoff (`EpochHandoff` in runtime.ts;
 * research/2026-10-30-global-cross-boot-resume-epoch-handoff.md): a backend
 * hands the tuples it would answer `up-to-date` at its shutdown to its
 * successor, which answers a replayed sub echoing the OLD epoch `up-to-date`
 * with no load — but only when nothing can have changed the value. The
 * failure mode of a wrong proof is a stale value nothing heals, so every
 * doubt must load. Each fallback arm is pinned here:
 *
 *   - inherited: a clean tuple, through `sub-batch` and `sub`, and a second
 *     tab of the same tuple — zero loader runs, the old version kept;
 *   - loads: no record (and a record written later is found), a record that
 *     fails to load, a replay that cannot prove the gap (pruned), a replay
 *     that throws, a changelog row reaching the tuple, a live change after
 *     the shadows were installed, a definition mismatch, an echoed version the
 *     old backend did not vouch for, a route table outside the changelog, an
 *     entry with no definition, a tuple this process already served;
 *   - the old half leaves out a tuple with a pending change;
 *   - after an inheritance the first change reloads the tuple and ships it at
 *     the next version.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { mintRoutePlan, type TableChange } from "./routing";
import type {
  HandoffState,
  ResourceParams,
  ResumeRecord,
  ResumeReplayOutcome,
} from "./runtime";
import {
  createHarness,
  makeClientView,
  tick,
  type Harness,
  type RecordedFrame,
} from "./test-support";
import { feedChange } from "./testing/routed-fixture";

const rowsSchema = z.array(z.object({ id: z.string(), n: z.number() }));
const keyOf = (r: unknown) => (r as { id: string }).id;
const idsOf = (p: ResourceParams) => (p.ids ?? "").split(",").filter(Boolean);
const TABLE = "pt_table";
const A = { ids: "a" };

function pointPlan(definition: string | undefined) {
  return mintRoutePlan({
    routes: [
      {
        id: "base",
        table: TABLE,
        map: { kind: "identity" },
        columns: ["id", "n"],
      },
    ],
    usesOf: () => new Map([["base", { role: "membership" as const }]]),
    ...(definition !== undefined
      ? { handoffDefinition: () => ({ kind: "defined" as const, definition }) }
      : {}),
  });
}

/** One backend: a routed point read over a shared simulated table. */
function backend(
  table: Map<string, number>,
  o: {
    definition?: string | undefined;
    resumeEpoch?: (epoch: string) => Promise<ResumeRecord | null>;
    sockets?: number;
    resumeNoRecordRetryMs?: number;
  } = {},
) {
  const loads: string[][] = [];
  const errors: string[] = [];
  const h = createHarness({
    sockets: o.sockets ?? 2,
    ...(o.resumeEpoch !== undefined ? { resumeEpoch: o.resumeEpoch } : {}),
    ...(o.resumeNoRecordRetryMs !== undefined
      ? { resumeNoRecordRetryMs: o.resumeNoRecordRetryMs }
      : {}),
    reportError: (ctx) => errors.push(ctx),
  });
  h.runtime.defineResource(
    {
      key: "pt",
      schema: rowsSchema,
      keyed: { keyOf },
      validateParams: () => {},
    },
    {
      routes: pointPlan("definition" in o ? o.definition : "def-1"),
      membership: { kind: "point", idsOf },
      loader: (p: ResourceParams, c?: { affectedIds: readonly string[] }) => {
        const ids = c ? [...c.affectedIds] : idsOf(p);
        loads.push(ids);
        return ids
          .filter((id) => table.has(id))
          .map((id) => ({ id, n: table.get(id)! }));
      },
    },
  );
  return { h, loads, errors };
}

/** The old backend serves `A` once, and hands over at `version` / `epoch`. */
async function oldBackend(table: Map<string, number>) {
  const old = backend(table);
  await old.h.subscribe("pt", A);
  const ack = old.h.frames.find((f) => f.kind === "sub-ack")!;
  return { ...old, version: ack.version!, epoch: ack.epoch! };
}

function record(
  state: HandoffState,
  o: {
    changes?: TableChange[];
    replay?: ResumeRecord["replay"];
    tables?: string[];
  } = {},
): ResumeRecord {
  return {
    tuples: state.tuples,
    changelogTables: new Set(o.tables ?? [TABLE]),
    replay:
      o.replay ??
      (async (route) => {
        for (const c of o.changes ?? []) route(c);
        return { ok: true };
      }),
  };
}

const change = (ids: string[]): TableChange => ({
  source: "feed",
  table: TABLE,
  op: "U",
  ids,
  keys: null,
  unchanged: null,
});

const loadsOf = (b: { loads: string[][] }) => b.loads.length;
const upToDate = (h: Harness) =>
  h.frames.flatMap((f) =>
    f.kind === "up-to-date-batch"
      ? (f.entries ?? []).map((e) => ({ version: e.version, epoch: f.epoch }))
      : f.kind === "up-to-date"
        ? [{ version: f.version, epoch: f.epoch }]
        : [],
  );
const subAcks = (h: Harness) => h.frames.filter((f) => f.kind === "sub-ack");

describe("the epoch handoff — inherited", () => {
  test("a clean tuple's replay is answered up-to-date at the old version, with no load; a second tab inherits it too", async () => {
    const table = new Map([["a", 1]]);
    const old = await oldBackend(table);
    const state = old.h.runtime.handoffState();
    expect(state.tuples).toEqual([
      {
        key: "pt",
        pk: expect.any(String),
        params: A,
        version: old.version,
        definition: "def-1",
      },
    ]);

    const next = backend(table, { resumeEpoch: async () => record(state) });
    await next.h.subscribeBatch(
      [{ key: "pt", params: A, version: old.version }],
      {
        epoch: old.epoch,
      },
    );
    await tick();
    const own = next.h.frames.find((f) => f.kind === "up-to-date-batch")!;
    expect(own.epoch).not.toBe(old.epoch);
    expect(upToDate(next.h)).toEqual([
      { version: old.version, epoch: own.epoch },
    ]);
    expect(loadsOf(next)).toBe(0);

    // Another tab, on another socket, through a single `sub`.
    await next.h.subscribe("pt", A, {
      socket: 1,
      epoch: old.epoch,
      version: old.version,
    });
    await tick();
    expect(upToDate(next.h)).toHaveLength(2);
    expect(loadsOf(next)).toBe(0);
  });

  test("after an inheritance, the first change reloads the tuple and ships it at the next version", async () => {
    const table = new Map([["a", 1]]);
    const old = await oldBackend(table);
    const next = backend(table, {
      resumeEpoch: async () => record(old.h.runtime.handoffState()),
    });
    await next.h.subscribeBatch(
      [{ key: "pt", params: A, version: old.version }],
      {
        epoch: old.epoch,
      },
    );
    await tick();
    table.set("a", 2);
    feedChange(next.h, { table: TABLE, op: "U", ids: ["a"] });
    await tick();
    await tick();
    expect(loadsOf(next)).toBe(1);
    const pushed = next.h.pushesFor("pt");
    expect(pushed.at(-1)!.version).toBe(old.version + 1);
  });
});

describe("the epoch handoff — the client converges after an inheritance", () => {
  // The batch answer, as the client applies it: one `up-to-date` per entry.
  const asClient = (frames: RecordedFrame[]): RecordedFrame[] =>
    frames.flatMap((f) =>
      f.kind === "up-to-date-batch"
        ? (f.entries ?? []).map((e) => ({
            ...f,
            kind: "up-to-date",
            key: e.key,
            params: e.params,
            version: e.version,
          }))
        : [f],
    );

  for (const [name, mutate, op] of [
    ["a row deleted", (t: Map<string, number>) => t.delete("a"), "D"],
    ["a row updated", (t: Map<string, number>) => t.set("a", 7), "U"],
  ] as const) {
    test(`${name} after the inheritance reaches the tab that kept the old value`, async () => {
      const table = new Map([["a", 1]]);
      const old = await oldBackend(table);
      const view = makeClientView(keyOf);
      view.applyAll(old.h.frames.filter((f) => f.key === "pt"));
      expect(view.value).toEqual([{ id: "a", n: 1 }]);

      const next = backend(table, {
        resumeEpoch: async () => record(old.h.runtime.handoffState()),
      });
      await next.h.subscribeBatch(
        [{ key: "pt", params: A, version: old.version }],
        { epoch: old.epoch },
      );
      await tick();
      expect(loadsOf(next)).toBe(0);

      mutate(table);
      feedChange(next.h, { table: TABLE, op, ids: ["a"] });
      await tick();
      await tick();
      view.applyAll(asClient(next.h.framesFor(0)));
      expect(view.value).toEqual(
        table.has("a") ? [{ id: "a", n: table.get("a")! }] : [],
      );
    });
  }
});

describe("the epoch handoff — a later load never absorbs a change the claimed tab lacks", () => {
  test("another tab's load reads a change still in flight to the claimed tab: the change still reaches it", async () => {
    const table = new Map([["a", 1]]);
    const old = await oldBackend(table);
    const view = makeClientView(keyOf);
    view.applyAll(old.h.frames.filter((f) => f.key === "pt"));

    const next = backend(table, {
      resumeEpoch: async () => record(old.h.runtime.handoffState()),
    });
    await next.h.subscribeBatch(
      [{ key: "pt", params: A, version: old.version }],
      { epoch: old.epoch },
    );
    await tick();
    expect(loadsOf(next)).toBe(0);

    // The row changes; its NOTIFY has not reached the router yet when a tab
    // with no echo loads the tuple — that load reads the new value.
    table.set("a", 9);
    await next.h.subscribe("pt", A, { socket: 1 });
    expect(loadsOf(next)).toBe(1);
    // The change arrives: the claimed tab must receive it.
    feedChange(next.h, { table: TABLE, op: "U", ids: ["a"] });
    await tick();
    await tick();
    view.applyAll(
      next.h.framesFor(0).flatMap((f) =>
        f.kind === "up-to-date-batch"
          ? (f.entries ?? []).map((e) => ({
              ...f,
              kind: "up-to-date",
              key: e.key,
              params: e.params,
              version: e.version,
            }))
          : [f],
      ),
    );
    expect(view.value).toEqual([{ id: "a", n: 9 }]);
  });
});

describe("the epoch handoff — every doubt loads", () => {
  async function replayed(o: {
    resumeEpoch?: (
      state: HandoffState,
    ) => (epoch: string) => Promise<ResumeRecord | null>;
    echoed?: (v: number) => number;
    definition?: string | undefined;
    before?: (next: ReturnType<typeof backend>) => Promise<void>;
  }) {
    const table = new Map([["a", 1]]);
    const old = await oldBackend(table);
    const state = old.h.runtime.handoffState();
    const next = backend(table, {
      ...("definition" in o ? { definition: o.definition } : {}),
      resumeEpoch: (o.resumeEpoch ?? ((s) => async () => record(s)))(state),
    });
    await o.before?.(next);
    const at = loadsOf(next);
    await next.h.subscribeBatch(
      [
        {
          key: "pt",
          params: A,
          version: (o.echoed ?? ((v) => v))(old.version),
        },
      ],
      { epoch: old.epoch },
    );
    await tick();
    await tick();
    return { next, old, loadedHere: loadsOf(next) - at };
  }

  test("no record: loads — and a record written later is found by the next replay", async () => {
    const table = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const old = backend(table);
    await old.h.subscribe("pt", A);
    await old.h.subscribe("pt", { ids: "b" });
    const acks = subAcks(old.h);
    const epoch = acks[0]!.epoch!;
    const state = old.h.runtime.handoffState();
    let written = false;
    const next = backend(table, {
      resumeEpoch: async () => (written ? record(state) : null),
      resumeNoRecordRetryMs: 0,
    });
    await next.h.subscribeBatch(
      [{ key: "pt", params: { ids: "b" }, version: acks[1]!.version! }],
      { epoch },
    );
    await tick();
    expect(loadsOf(next)).toBe(1);
    expect(upToDate(next.h)).toEqual([]);

    // The negative answer is kept only briefly: once the record exists it is read.
    await tick();
    written = true;
    await next.h.subscribeBatch(
      [{ key: "pt", params: A, version: acks[0]!.version! }],
      { epoch, tabId: "tab-2" },
    );
    await tick();
    expect(loadsOf(next)).toBe(1);
    expect(upToDate(next.h)).toHaveLength(1);
  });

  test("a record that fails to load: loads, reported", async () => {
    const { next, loadedHere } = await replayed({
      resumeEpoch: () => async () => {
        throw new Error("no table");
      },
    });
    expect(loadedHere).toBe(1);
    expect(upToDate(next.h)).toEqual([]);
    expect(next.errors.some((e) => e.includes("epoch handoff"))).toBe(true);
  });

  test("a replay that cannot prove the gap (history pruned past the cut): loads", async () => {
    const { next, loadedHere } = await replayed({
      resumeEpoch: (s) => async () =>
        record(s, {
          replay: async (): Promise<ResumeReplayOutcome> => ({
            ok: false,
            reason: "pruned",
          }),
        }),
    });
    expect(loadedHere).toBe(1);
    expect(upToDate(next.h)).toEqual([]);
  });

  test("a replay that throws: loads, reported", async () => {
    const { next, loadedHere } = await replayed({
      resumeEpoch: (s) => async () =>
        record(s, {
          replay: async () => {
            throw new Error("changelog read failed");
          },
        }),
    });
    expect(loadedHere).toBe(1);
    expect(next.errors.some((e) => e.includes("replaying"))).toBe(true);
  });

  test("a changelog row since the cut reaching the tuple: loads; one reaching another id does not", async () => {
    const reached = await replayed({
      resumeEpoch: (s) => async () => record(s, { changes: [change(["a"])] }),
    });
    expect(reached.loadedHere).toBe(1);
    expect(upToDate(reached.next.h)).toEqual([]);

    const other = await replayed({
      resumeEpoch: (s) => async () => record(s, { changes: [change(["z"])] }),
    });
    expect(other.loadedHere).toBe(0);
    expect(upToDate(other.next.h)).toHaveLength(1);
  });

  test("an unscoped changelog row (ids unknown) on the tuple's table: loads", async () => {
    const { loadedHere } = await replayed({
      resumeEpoch: (s) => async () =>
        record(s, {
          changes: [{ ...change([]), ids: null }],
        }),
    });
    expect(loadedHere).toBe(1);
  });

  test("a live change after the shadows were installed, before the claim: loads", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let next!: ReturnType<typeof backend>;
    const out = await replayed({
      resumeEpoch: (s) => async () =>
        record(s, {
          replay: async () => {
            // The shadows are installed; a change routed live now must reach them.
            feedChange(next.h, { table: TABLE, op: "U", ids: ["a"] });
            await gate;
            return { ok: true };
          },
        }),
      before: async (n) => {
        next = n;
        setTimeout(release, 0);
      },
    });
    expect(out.loadedHere).toBeGreaterThanOrEqual(1);
    expect(upToDate(out.next.h)).toEqual([]);
  });

  test("a definition mismatch (a deploy moved the SQL): loads", async () => {
    const { next, loadedHere } = await replayed({ definition: "def-2" });
    expect(loadedHere).toBe(1);
    expect(upToDate(next.h)).toEqual([]);
  });

  test("an entry with no definition never asks the handoff: loads", async () => {
    let asked = false;
    const { loadedHere } = await replayed({
      definition: undefined,
      resumeEpoch: (s) => async () => {
        asked = true;
        return record(s);
      },
    });
    expect(loadedHere).toBe(1);
    expect(asked).toBe(false);
  });

  test("an echoed version the old backend did not vouch for: loads", async () => {
    const { next, loadedHere } = await replayed({ echoed: (v) => v - 1 });
    expect(loadedHere).toBe(1);
    expect(upToDate(next.h)).toEqual([]);
  });

  test("a route table whose changes are not in the changelog: loads", async () => {
    const { loadedHere } = await replayed({
      resumeEpoch: (s) => async () => record(s, { tables: ["other_table"] }),
    });
    expect(loadedHere).toBe(1);
  });

  test("a tuple this process already served itself: loads", async () => {
    const { next, loadedHere } = await replayed({
      before: async (n) => {
        // A tab with no echo subscribes first: this process loads and holds it.
        await n.h.subscribe("pt", A, { socket: 1 });
      },
    });
    expect(loadedHere).toBe(1);
    expect(upToDate(next.h)).toEqual([]);
  });
});

describe("the epoch handoff — the old half", () => {
  test("a tuple a change reached and has not drained yet is left out", async () => {
    const table = new Map([["a", 1]]);
    const old = await oldBackend(table);
    table.set("a", 5);
    feedChange(old.h, { table: TABLE, op: "U", ids: ["a"] });
    // Synchronously, as after a feed cut: the change made its pending.
    expect(old.h.runtime.handoffState().tuples).toEqual([]);
    await tick();
    await tick();
    // Drained: vouched for again, at the version it shipped.
    const [t] = old.h.runtime.handoffState().tuples;
    expect(t!.version).toBe(old.version + 1);
  });

  test("an entry with no definition hands nothing over", async () => {
    const table = new Map([["a", 1]]);
    const old = backend(table, { definition: undefined });
    await old.h.subscribe("pt", A);
    expect(old.h.runtime.handoffState().tuples).toEqual([]);
  });
});
