import { describe, expect, test } from "bun:test";
import { nullable } from "@plugins/fields/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { z } from "zod";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  applyRows,
  choose,
  liveCollection,
  liveValue,
  patchRow,
  patchValue,
  patchWhere,
  readLiveEffect,
  removeRow,
  upsertRow,
  type LiveMembership,
} from "@plugins/network/plugins/live/core";
import {
  createPredictStore,
  predictRow,
  predictRows,
  predictValue,
  rowPending,
  valueParamsKey,
  type PredictHolder,
  type PredictOp,
  type PredictRow,
  type PredictTuple,
} from "./predict-overlay";

const convs = entityRef("overlay_convs", {
  id: textField(),
  status: enumTextField(["working", "done"] as const, { label: "Status" }),
  workingOn: nullable(textField()),
});

const exit = defineEndpoint({
  route: "POST /api/overlay/:id/exit",
  effect: (on) =>
    patchRow(
      on,
      convs,
      ({ params }) => params.id,
      () => ({ set: { status: "done", workingOn: null } }),
    ),
});

/** An active list over the entity: `status ne done` — its membership. */
const activeList = liveCollection("overlay.active", {
  from: convs,
  pick: ["status"],
  carry: { pick: ["id", "workingOn"] },
  id: "id",
  membership: { column: "status", op: "ne", operand: "done" } as const,
  all: { orderBy: [["id", "asc"]], unbounded: { reason: "a test set" } },
});
const ACTIVE: LiveMembership = activeList.membership!;

function opFor(id: string, opId = `op-${id}`): PredictOp {
  const { targets } = readLiveEffect(
    exit.effect as Parameters<typeof readLiveEffect>[0],
  ).resolve({ params: { id }, body: undefined });
  return {
    opId,
    route: exit.route,
    params: { id },
    targets,
    subjects: new Set(targets.map((t) => t.subject)),
    dispatchedAt: 0,
    retired: new Set(),
  };
}

const working = (id: string): PredictRow => ({
  id,
  status: "working",
  workingOn: "x",
});
const done = (id: string): PredictRow => ({
  id,
  status: "done",
  workingOn: null,
});

/** A tuple descriptor of the convs entity (overrides last). */
function tuple(
  tupleKey: string,
  extra: Partial<PredictTuple> = {},
): PredictTuple {
  return { tupleKey, subject: "overlay_convs", idField: "id", ...extra };
}

/** An op of a predicted endpoint, its effect resolved against `req`. */
function opOf(
  endpoint: { readonly effect: unknown },
  req: { params?: Record<string, string>; body?: unknown },
  opId: string,
): PredictOp {
  const { targets } = readLiveEffect(
    endpoint.effect as Parameters<typeof readLiveEffect>[0],
  ).resolve({ params: req.params ?? {}, body: req.body });
  return {
    opId,
    route: "POST /x",
    params: req.params ?? {},
    targets,
    subjects: new Set(targets.map((t) => t.subject)),
    dispatchedAt: 0,
    retired: new Set(),
  };
}

describe("predictRows", () => {
  test("no op touching the tuple keeps the rows' identity", () => {
    const rows = [working("a"), working("b")];
    const t = tuple("t", { membership: ACTIVE });
    expect(predictRows([], t, rows)).toBe(rows);
    expect(predictRows([opFor("zz")], t, rows)).toBe(rows);
    expect(
      predictRows([opFor("a")], { ...t, subject: "other_entity" }, rows),
    ).toBe(rows);
  });

  test("patches a held row in place, untouched rows keep their identity", () => {
    const rows = [working("a"), working("b")];
    const out = predictRows([opFor("a")], tuple("t"), rows);
    expect(out[0]).toEqual(done("a"));
    expect(out[1]).toBe(rows[1]);
  });

  test("a row the patch moves out of the membership leaves the tuple", () => {
    const rows = [working("a"), working("b")];
    const out = predictRows(
      [opFor("a")],
      tuple("t", { membership: ACTIVE }),
      rows,
    );
    expect(out.map((r) => r.id)).toEqual(["b"]);
  });

  test("a patch never inserts, and keeps only the row's own keys", () => {
    const rows = [{ id: "a", status: "working" }];
    const out = predictRows([opFor("a"), opFor("new")], tuple("t"), rows);
    expect(out).toEqual([{ id: "a", status: "done" }]);
  });

  test("a tuple that retired the op reads the server's row", () => {
    const op = { ...opFor("a"), retired: new Set(["t"]) };
    const rows = [working("a")];
    const t = tuple("t", { membership: ACTIVE });
    expect(predictRows([op], t, rows)).toBe(rows);
    expect(predictRow([op], { ...t, tupleKey: "u" }, rows[0]!)).toBe(undefined);
    expect(rowPending([op], "t", "overlay_convs", "a", rows[0])).toBe(false);
    expect(rowPending([op], "u", "overlay_convs", "a", rows[0])).toBe(true);
  });
});

// --- upsertRow ------------------------------------------------------------

const scores = entityRef("overlay_scores", {
  id: textField(),
  status: enumTextField(["working", "done"] as const, { label: "Status" }),
  points: intField({ label: "Points" }),
});
const setScore = defineEndpoint({
  route: "POST /api/overlay-score/:id",
  body: z.object({ points: z.number() }),
  effect: (on) =>
    upsertRow(
      on,
      scores,
      ({ params }) => params.id,
      (row, { params, body }) => ({
        id: params.id,
        status: row?.status ?? "working",
        points: body.points,
      }),
    ),
});
const setScoreCompared = defineEndpoint({
  route: "POST /api/overlay-score-compared/:id",
  body: z.object({ points: z.number() }),
  effect: (on) =>
    upsertRow(
      on,
      scores,
      ({ params }) => params.id,
      (row, { params, body }) => ({
        id: params.id,
        status: row?.status ?? "working",
        points: body.points,
      }),
      { set: ({ body }) => ({ points: body.points }) },
    ),
});
const scoresActive = liveCollection("overlay.scores-active", {
  from: scores,
  pick: ["status", "points"],
  carry: { pick: ["id"] },
  id: "id",
  membership: { column: "status", op: "ne", operand: "done" } as const,
  all: { orderBy: [["points", "desc"]], unbounded: { reason: "a test set" } },
});
const point = (id: string, points: number): PredictRow => ({
  id,
  status: "working",
  points,
});
const scoreTuple = (
  tupleKey: string,
  extra: Partial<PredictTuple> = {},
): PredictTuple => ({
  tupleKey,
  subject: "overlay_scores",
  idField: "id",
  ...extra,
});

describe("upsertRow", () => {
  test("an absent row enters a read that admits it, and only that read", () => {
    const op = opOf(
      setScore,
      { params: { id: "n" }, body: { points: 3 } },
      "u",
    );
    const byId = scoreTuple("by-id", {
      entrant: (r) => (r.id === "n" ? r : undefined),
    });
    expect(predictRow([op], byId, undefined)).toEqual(point("n", 3));
    // A window (no entrant) never gains it.
    const rows = [point("a", 1)];
    expect(predictRows([op], scoreTuple("window"), rows)).toBe(rows);
    // Another id's by-id read does not admit it.
    expect(
      predictRow(
        [op],
        scoreTuple("other", { entrant: (r) => (r.id === "x" ? r : undefined) }),
        undefined,
      ),
    ).toBeUndefined();
  });

  test("a held row is upserted in place", () => {
    const op = opOf(
      setScore,
      { params: { id: "a" }, body: { points: 9 } },
      "u",
    );
    const out = predictRows([op], scoreTuple("t"), [point("a", 1)]);
    expect(out).toEqual([point("a", 9)]);
  });

  test("an `all` set gains the entrant in its order; leaving its membership it does not", () => {
    const op = opOf(
      setScore,
      { params: { id: "n" }, body: { points: 5 } },
      "u",
    );
    const t = scoreTuple("all", {
      membership: scoresActive.membership!,
      entrant: (r) => r,
      order: [["points", "desc"]],
    });
    const rows = [point("a", 9), point("b", 1)];
    expect(predictRows([op], t, rows).map((r) => r.id)).toEqual([
      "a",
      "n",
      "b",
    ]);
  });
});

// --- choose ---------------------------------------------------------------

const swing = defineEndpoint({
  route: "POST /api/overlay-swing/:id",
  body: z.object({ mode: z.enum(["score", "set"]), points: z.number() }),
  effect: (on) =>
    choose(on, ({ body }) => body.mode, {
      score: removeRow(on, scores, ({ params }) => params.id),
      set: upsertRow(
        on,
        scores,
        ({ params }) => params.id,
        (_row, { params, body }) => ({
          id: params.id,
          status: "working",
          points: body.points,
        }),
      ),
    }),
});

describe("choose", () => {
  test("each request resolves its own branch", () => {
    const rows = [point("a", 1)];
    const remove = opOf(
      swing,
      { params: { id: "a" }, body: { mode: "score", points: 0 } },
      "s",
    );
    expect(predictRows([remove], scoreTuple("t"), rows)).toEqual([]);
    const set = opOf(
      swing,
      { params: { id: "a" }, body: { mode: "set", points: 4 } },
      "s",
    );
    expect(predictRows([set], scoreTuple("t"), rows)).toEqual([point("a", 4)]);
  });
});

// --- where ----------------------------------------------------------------

const resetDone = defineEndpoint({
  route: "POST /api/overlay-reset",
  effect: (on) =>
    patchWhere(
      on,
      scores,
      () => ({ column: "status", op: "eq", operand: "done" }),
      () => ({ points: 0 }),
    ),
});

describe("patchWhere", () => {
  test("rewrites every held row matching the filter, and nothing else", () => {
    const op = opOf(resetDone, {}, "w");
    const rows = [
      point("a", 4),
      { id: "b", status: "done", points: 7 },
      { id: "c", status: "done", points: 2 },
    ];
    const out = predictRows([op], scoreTuple("t"), rows);
    expect(out[0]).toBe(rows[0]);
    expect(out.slice(1)).toEqual([
      { id: "b", status: "done", points: 0 },
      { id: "c", status: "done", points: 0 },
    ]);
  });

  test("a read whose rows lack a filtered column is left to the server", () => {
    const op = opOf(resetDone, {}, "w");
    const rows = [{ id: "b", points: 7 }];
    expect(predictRows([op], scoreTuple("t"), rows)).toBe(rows);
  });
});

// --- ranks ----------------------------------------------------------------

const bump = defineEndpoint({
  route: "POST /api/overlay-bump/:id",
  effect: (on) =>
    applyRows(
      on,
      scores,
      ({ params }) => [params.id],
      (rows) => rows.map((r) => ({ ...r, points: r.points + 10 })),
    ),
});

describe("re-sort", () => {
  test("a row whose order field changed moves among the held rows", () => {
    const op = opOf(bump, { params: { id: "c" } }, "r");
    const rows = [point("a", 9), point("b", 5), point("c", 1)];
    const t = scoreTuple("t", { order: [["points", "desc"]] });
    const out = predictRows([op], t, rows);
    expect(out.map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(out[1]).toBe(rows[0]);
  });

  test("past the last held row of a read with more, the row leaves", () => {
    const sink = defineEndpoint({
      route: "POST /api/overlay-sink/:id",
      effect: (on) =>
        applyRows(
          on,
          scores,
          ({ params }) => [params.id],
          (rows) => rows.map((r) => ({ ...r, points: -1 })),
        ),
    });
    const op = opOf(sink, { params: { id: "a" } }, "r");
    const rows = [point("a", 9), point("b", 5)];
    const t = scoreTuple("t", { order: [["points", "desc"]], more: true });
    expect(predictRows([op], t, rows).map((r) => r.id)).toEqual(["b"]);
    // With nothing past the held rows, it lands last.
    expect(
      predictRows([op], { ...t, more: false }, rows).map((r) => r.id),
    ).toEqual(["b", "a"]);
  });
});

describe("an order field holding a value object", () => {
  // A `rankValueField` row carries a `Rank`, ordered by its wire key.
  const ranked = (id: string, rank: string, points: number): PredictRow => ({
    ...point(id, points),
    rank: Rank.from(rank),
  });

  test("a patch that leaves the rank alone keeps the order", () => {
    const op = opOf(bump, { params: { id: "b" } }, "r");
    const rows = [ranked("a", "a0", 1), ranked("b", "a1", 1)];
    const t = scoreTuple("t", { order: [["rank", "asc"]] });
    expect(predictRows([op], t, rows).map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("ties on the rank re-sort by the next order field", () => {
    const op = opOf(bump, { params: { id: "b" } }, "r");
    const rows = [ranked("a", "a0", 5), ranked("b", "a0", 1)];
    const t = scoreTuple("t", {
      order: [
        ["rank", "asc"],
        ["points", "desc"],
      ],
    });
    expect(predictRows([op], t, rows).map((r) => r.id)).toEqual(["b", "a"]);
  });
});

// --- values ---------------------------------------------------------------

const picks = liveValue("overlay.picks", {
  schema: z.object({ slot: z.string().nullable() }),
  params: ["name", "scope?"],
});
const pick = defineEndpoint({
  route: "POST /api/overlay-pick/:name",
  body: z.object({ slot: z.string() }),
  effect: (on) =>
    patchValue(
      on,
      picks,
      ({ params }) => ({ name: params.name, scope: "" }),
      (_v, { body }) => ({ slot: body.slot }),
    ),
});

describe("patchValue", () => {
  test("folds over exactly its tuple, params canonical", () => {
    const op = opOf(pick, { params: { name: "p" }, body: { slot: "x" } }, "v");
    const t = op.targets[0]!;
    if (t.kind !== "value") throw new Error("expected a value target");
    // The empty optional param is dropped: one tuple however it is spelled.
    expect(t.params).toEqual({ name: "p" });
    const key = valueParamsKey({ name: "p" });
    const server = { slot: null };
    expect(
      predictValue([op], "tk", t.subject, "overlay.picks", key, server),
    ).toEqual({ slot: "x" });
    expect(
      predictValue(
        [op],
        "tk",
        t.subject,
        "overlay.picks",
        valueParamsKey({ name: "q" }),
        server,
      ),
    ).toBe(server);
  });
});

// --- a `from: null` collection target -------------------------------------

const notes = liveCollection("overlay.notes", {
  fields: { body: textField({ label: "Body" }) },
  carry: { fields: { id: textField() } },
  id: "id",
});
const editNote = defineEndpoint({
  route: "POST /api/overlay-note/:id",
  body: z.object({ body: z.string() }),
  effect: (on) =>
    patchRow(
      on,
      notes,
      ({ params }) => params.id,
      ({ body }) => ({ set: { body: body.body } }),
    ),
});

describe("a collection declared `from: null` as the target", () => {
  test("keyed by the collection's own key, applied to its reads only", () => {
    const op = opOf(
      editNote,
      { params: { id: "n1" }, body: { body: "hi" } },
      "c",
    );
    expect([...op.subjects]).toEqual(["collection:overlay.notes"]);
    const rows = [{ id: "n1", body: "old" }];
    const own: PredictTuple = {
      tupleKey: "t",
      subject: "collection:overlay.notes",
      idField: "id",
    };
    expect(predictRows([op], own, rows)).toEqual([{ id: "n1", body: "hi" }]);
    expect(
      predictRows([op], { ...own, subject: "collection:other" }, rows),
    ).toBe(rows);
  });

  test("a collection `from` an entity is refused: target the entity", () => {
    expect(() =>
      defineEndpoint({
        route: "POST /api/overlay-bad/:id",
        effect: (on) =>
          // @ts-expect-error — a collection over an entity is not a target
          removeRow(on, activeList, ({ params }) => params.id),
      }),
    ).toThrow(/target the entity/);
  });
});

describe("createPredictStore — per-tuple retirement", () => {
  function holder(
    tupleKey: string,
    rows: { current: PredictRow[] | undefined },
    seen: (commits: readonly string[]) => boolean = () => false,
    extra: Partial<PredictTuple> = {},
  ): PredictHolder {
    return {
      kind: "rows",
      tupleKey,
      subject: "overlay_convs",
      idField: "id",
      rows: () => rows.current,
      seen,
      ...extra,
    };
  }

  test("by-id confirms first; the stale active list keeps the op until its own frame drops the row", () => {
    const store = createPredictStore(() => 100);
    const doneAt: number[] = [];
    const byId = { current: [working("a")] as PredictRow[] | undefined };
    const active = {
      current: [working("a"), working("b")] as PredictRow[] | undefined,
    };
    store.register(holder("by-id", byId));
    store.register(holder("active", active));
    store.add(opFor("a"), (_op, at) => doneAt.push(at));
    store.update("op-a", (op) => ({ ...op, ackedAt: 50 }));
    store.sweep();
    expect(store.ops()).toHaveLength(1);

    // The by-id tuple's frame lands first: retired THERE only.
    byId.current = [done("a")];
    store.sweep();
    const op = store.op("op-a")!;
    expect([...op.retired]).toEqual(["by-id"]);
    expect(doneAt).toEqual([]);
    // The active list still holds the stale row — still hidden there.
    expect(
      predictRows(
        store.ops(),
        tuple("active", { membership: ACTIVE }),
        active.current!,
      ).map((r) => r.id),
    ).toEqual(["b"]);

    // Its own frame drops the row: nothing needs the op any more — done.
    active.current = [working("b")];
    store.sweep();
    expect(store.ops()).toEqual([]);
    expect(doneAt).toEqual([100]);
  });

  test("an op is never done before its ack, even when every tuple agrees", () => {
    const store = createPredictStore();
    const rows = { current: [done("a")] as PredictRow[] | undefined };
    store.register(holder("by-id", rows));
    let finished = false;
    store.add(opFor("a"), () => {
      finished = true;
    });
    store.sweep();
    expect(finished).toBe(false);
    expect([...store.op("op-a")!.retired]).toEqual(["by-id"]);
    store.update("op-a", (op) => ({ ...op, ackedAt: 1 }));
    store.sweep();
    expect(finished).toBe(true);
  });

  test("a holder leaving may complete the op it held back", () => {
    const store = createPredictStore();
    const rows = { current: [working("a")] as PredictRow[] | undefined };
    const off = store.register(holder("active", rows));
    let finished = false;
    store.add(opFor("a"), () => {
      finished = true;
    });
    store.update("op-a", (op) => ({ ...op, ackedAt: 1 }));
    store.sweep();
    expect(finished).toBe(false);
    off();
    expect(finished).toBe(true);
  });

  test("opsFor keeps its array while the subject's ops do not change; remove completes nothing", () => {
    const store = createPredictStore();
    const before = store.opsFor("overlay_convs");
    expect(store.opsFor("overlay_convs")).toBe(before);
    let finished = false;
    store.add(opFor("a"), () => {
      finished = true;
    });
    const withOp = store.opsFor("overlay_convs");
    expect(withOp).toHaveLength(1);
    expect(store.opsFor("overlay_convs")).toBe(withOp);
    store.remove("op-a");
    expect(store.opsFor("overlay_convs")).toHaveLength(0);
    expect(finished).toBe(false);
  });
});

describe("commit confirmation — a target with nothing to compare", () => {
  function scoreHolder(
    tupleKey: string,
    rows: { current: PredictRow[] | undefined },
    seen: { current: readonly string[] },
    extra: Partial<PredictTuple> = {},
  ): PredictHolder {
    return {
      kind: "rows",
      tupleKey,
      subject: "overlay_scores",
      idField: "id",
      rows: () => rows.current,
      seen: (commits) => commits.some((c) => seen.current.includes(c)),
      ...extra,
    };
  }

  test("an increment stays through an ack that lands before its frame", () => {
    const store = createPredictStore();
    const rows = { current: [point("c", 1)] as PredictRow[] | undefined };
    const seen = { current: [] as readonly string[] };
    store.register(scoreHolder("t", rows, seen));
    let finished = false;
    store.add(opOf(bump, { params: { id: "c" } }, "r"), () => {
      finished = true;
    });
    // The ack names its commit; the tuple's frames have not seen it.
    store.update("r", (op) => ({ ...op, ackedAt: 1, commits: ["700"] }));
    store.sweep();
    expect(finished).toBe(false);
    // Still +10 over the stale row — no vanish-and-return.
    expect(predictRows(store.ops(), scoreTuple("t"), rows.current!)[0]).toEqual(
      point("c", 11),
    );
    // A frame of another write: still not ours.
    seen.current = ["650"];
    store.sweep();
    expect(finished).toBe(false);
    // The frame carrying it: the tuple saw commit 700 — done.
    rows.current = [point("c", 11)];
    seen.current = ["700"];
    store.sweep();
    expect(finished).toBe(true);
  });

  test("an ack naming no commit confirms at the ack (a host with no capture)", () => {
    const store = createPredictStore();
    const rows = { current: [point("c", 1)] as PredictRow[] | undefined };
    store.register(scoreHolder("t", rows, { current: [] }));
    let finished = false;
    store.add(opOf(bump, { params: { id: "c" } }, "r"), () => {
      finished = true;
    });
    store.sweep();
    expect(finished).toBe(false);
    store.update("r", (op) => ({ ...op, ackedAt: 1, commits: [] }));
    store.sweep();
    expect(finished).toBe(true);
  });

  test("an upsert entering a by-id read applies until the tuple saw its commit", () => {
    const store = createPredictStore();
    const rows = { current: [] as PredictRow[] | undefined };
    const seen = { current: [] as readonly string[] };
    store.register(
      scoreHolder("by-id", rows, seen, {
        entrant: (r) => (r.id === "n" ? r : undefined),
      }),
    );
    let finished = false;
    store.add(
      opOf(setScore, { params: { id: "n" }, body: { points: 2 } }, "u"),
      () => {
        finished = true;
      },
    );
    store.update("u", (op) => ({ ...op, ackedAt: 1, commits: ["9"] }));
    store.sweep();
    expect(finished).toBe(false);
    rows.current = [point("n", 2)];
    seen.current = ["9"];
    store.sweep();
    expect(finished).toBe(true);
  });

  test("an upsert with `set` is confirmed by the row holding it, like a patch", () => {
    const store = createPredictStore();
    const rows = { current: [point("a", 1)] as PredictRow[] | undefined };
    store.register(scoreHolder("t", rows, { current: [] }));
    let finished = false;
    store.add(
      opOf(setScoreCompared, { params: { id: "a" }, body: { points: 4 } }, "u"),
      () => {
        finished = true;
      },
    );
    store.update("u", (op) => ({ ...op, ackedAt: 1, commits: ["5"] }));
    store.sweep();
    expect(finished).toBe(false);
    rows.current = [point("a", 4)];
    store.sweep();
    expect(finished).toBe(true);
  });

  test("a value target confirms on its tuple's commit", () => {
    const store = createPredictStore();
    const seen = { current: [] as readonly string[] };
    const op = opOf(pick, { params: { name: "p" }, body: { slot: "x" } }, "v");
    store.register({
      kind: "value",
      tupleKey: "picks|p",
      subject: [...op.subjects][0]!,
      key: "overlay.picks",
      paramsKey: valueParamsKey({ name: "p" }),
      held: () => true,
      seen: (commits) => commits.some((c) => seen.current.includes(c)),
    });
    let finished = false;
    store.add(op, () => {
      finished = true;
    });
    store.update("v", (o) => ({ ...o, ackedAt: 1, commits: ["3"] }));
    store.sweep();
    expect(finished).toBe(false);
    seen.current = ["3"];
    store.sweep();
    expect(finished).toBe(true);
  });
});
