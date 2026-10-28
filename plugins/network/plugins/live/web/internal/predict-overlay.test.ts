import { describe, expect, test } from "bun:test";
import { nullable } from "@plugins/fields/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import {
  liveCollection,
  patchRow,
  readLiveEffect,
  type LiveMembership,
} from "@plugins/network/plugins/live/core";
import {
  createPredictStore,
  predictRow,
  predictRows,
  rowPending,
  type PredictHolder,
  type PredictOp,
  type PredictRow,
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
    entities: new Set(targets.map((t) => t.entity)),
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

describe("predictRows", () => {
  test("no op touching the tuple keeps the rows' identity", () => {
    const rows = [working("a"), working("b")];
    expect(predictRows([], "t", "overlay_convs", "id", rows, ACTIVE)).toBe(
      rows,
    );
    expect(
      predictRows([opFor("zz")], "t", "overlay_convs", "id", rows, ACTIVE),
    ).toBe(rows);
    expect(
      predictRows([opFor("a")], "t", "other_entity", "id", rows, ACTIVE),
    ).toBe(rows);
  });

  test("patches a held row in place, untouched rows keep their identity", () => {
    const rows = [working("a"), working("b")];
    const out = predictRows(
      [opFor("a")],
      "t",
      "overlay_convs",
      "id",
      rows,
      undefined,
    );
    expect(out[0]).toEqual(done("a"));
    expect(out[1]).toBe(rows[1]);
  });

  test("a row the patch moves out of the membership leaves the tuple", () => {
    const rows = [working("a"), working("b")];
    const out = predictRows(
      [opFor("a")],
      "t",
      "overlay_convs",
      "id",
      rows,
      ACTIVE,
    );
    expect(out.map((r) => r.id)).toEqual(["b"]);
  });

  test("never inserts, and keeps only the row's own keys", () => {
    const rows = [{ id: "a", status: "working" }];
    const out = predictRows(
      [opFor("a"), opFor("new")],
      "t",
      "overlay_convs",
      "id",
      rows,
      undefined,
    );
    expect(out).toEqual([{ id: "a", status: "done" }]);
  });

  test("a tuple that retired the op reads the server's row", () => {
    const op = { ...opFor("a"), retired: new Set(["t"]) };
    const rows = [working("a")];
    expect(predictRows([op], "t", "overlay_convs", "id", rows, ACTIVE)).toBe(
      rows,
    );
    expect(predictRow([op], "u", "overlay_convs", "id", rows[0]!, ACTIVE)).toBe(
      undefined,
    );
    expect(rowPending([op], "t", "overlay_convs", "a")).toBe(false);
    expect(rowPending([op], "u", "overlay_convs", "a")).toBe(true);
  });
});

describe("createPredictStore — per-tuple retirement", () => {
  function holder(
    tupleKey: string,
    rows: { current: PredictRow[] | undefined },
  ): PredictHolder {
    return {
      tupleKey,
      entity: "overlay_convs",
      idField: "id",
      rows: () => rows.current,
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
        "active",
        "overlay_convs",
        "id",
        active.current!,
        ACTIVE,
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

  test("opsFor keeps its array while the entity's ops do not change; remove completes nothing", () => {
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
