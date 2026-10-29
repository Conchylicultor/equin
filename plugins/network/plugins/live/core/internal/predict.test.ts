import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import {
  brandEndpointEffect,
  defineEndpoint,
  type EffectOn,
} from "@plugins/infra/plugins/endpoints/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { liveCollection } from "./live-collection";
import { liveValue } from "./live-value";
import {
  applyRows,
  choose,
  effects,
  patchRow,
  patchValue,
  patchWhere,
  readLiveEffect,
  removeRow,
  removeWhere,
  upsertRow,
  upsertRows,
} from "./predict";

const convs = entityRef("pred_convs", {
  id: textField(),
  status: enumTextField(["working", "done"] as const, { label: "Status" }),
  workingOn: nullable(textField()),
  endedAt: nullable(dateField()),
});

// The call-site ergonomics the design rests on: no annotation, `params.id`
// typed by the route, `set` checked against the entity's fields.
const exit = defineEndpoint({
  route: "POST /api/pred/:id/exit",
  effect: (on) =>
    patchRow(
      on,
      convs,
      ({ params }) => params.id,
      () => ({
        set: { status: "done", workingOn: null },
        approx: { endedAt: new Date("2026-10-27T00:00:00.000Z") },
      }),
    ),
});

const rename = defineEndpoint({
  route: "POST /api/pred/:id/rename",
  body: z.object({ to: z.string() }),
  effect: (on) =>
    effects(
      patchRow(
        on,
        convs,
        ({ params }) => params.id,
        ({ body }) => ({ set: { workingOn: body.to } }),
        { confirmWithinMs: 3000 },
      ),
      removeRow(on, convs, ({ body }) => body.to, { confirmWithinMs: 5000 }),
    ),
});

/** A side table no entity ref names: a collection declared `from: null`. */
const notes = liveCollection("pred.notes", {
  fields: { body: textField({ label: "Body" }) },
  carry: { fields: { id: textField() } },
  id: "id",
});

/** Fields an extension exposes on `convs`, riding its rows under `$columns`. */
const playback = defineExtensionShape({
  key: "convId",
  fields: { plays: intField({ label: "Plays", default: 0 }) },
  exposes: { parent: convs, name: "playback", fields: { plays: {} } },
});
const SLICE = "pred_convs_ext_playback";

/** An `all` set over a side table, scoped by a key column. */
const marks = liveCollection("pred.marks", {
  fields: { label: textField({ label: "Label" }) },
  carry: { fields: { id: textField(), pageId: textField() } },
  id: "id",
  all: {
    by: ["pageId"],
    orderBy: [["id", "asc"]],
    unbounded: { reason: "test" },
  },
});

const counter = liveValue("pred.counter", {
  schema: z.object({ n: z.number() }),
  params: ["id"],
});

function _typeErrors() {
  defineEndpoint({
    route: "POST /api/pred/:id/note",
    effect: (on) =>
      patchRow(
        on,
        notes,
        ({ params }) => params.id,
        // @ts-expect-error — `title` is not a field of the collection's row
        () => ({ set: { title: "x" } }),
      ),
  });
  defineEndpoint({
    route: "POST /api/pred/:id/up",
    effect: (on) =>
      upsertRow(
        on,
        convs,
        ({ params }) => params.id,
        // @ts-expect-error — the upserted row must be a whole row of the entity
        () => ({ id: "x" }),
      ),
  });
  defineEndpoint({
    route: "POST /api/pred/:id/play",
    effect: (on) =>
      applyRows(
        on,
        playback.exposure,
        ({ params }) => [params.id],
        // @ts-expect-error — the slice's `plays` is a number
        (slices) => slices.map(() => ({ plays: "x" })),
      ),
  });
  defineEndpoint({
    route: "POST /api/pred/:id/v",
    effect: (on) =>
      patchValue(
        on,
        counter,
        ({ params }) => ({ id: params.id }),
        // @ts-expect-error — the reducer returns the value's type
        () => ({ n: "one" }),
      ),
  });
  defineEndpoint({
    route: "POST /api/pred/:id/x",
    effect: (on) =>
      patchRow(
        on,
        convs,
        // @ts-expect-error — the route has no `nope` param
        ({ params }) => params.nope,
        () => ({ set: {} }),
      ),
  });
  defineEndpoint({
    route: "POST /api/pred/:id/y",
    effect: (on) =>
      patchRow(
        on,
        convs,
        ({ params }) => params.id,
        // @ts-expect-error — "gone" is not a status option
        () => ({ set: { status: "gone" } }),
      ),
  });
  defineEndpoint({
    route: "POST /api/pred/:id/z",
    effect: (on) =>
      patchRow(
        on,
        convs,
        ({ params }) => params.id,
        // @ts-expect-error — `nope` is not a field of the entity
        () => ({ set: { nope: 1 } }),
      ),
  });
  // @ts-expect-error — a read declares no effect
  defineEndpoint({
    route: "GET /api/pred/:id",
    effect: (on) => removeRow(on, convs, ({ params }) => params.id),
  });
}

/** A builder's `on` outside `defineEndpoint` (a phantom: never read). */
const anyOn = {} as EffectOn<Record<string, never>, void>;

describe("predict builders", () => {
  test("the type assertions above compile", () => {
    expect(typeof _typeErrors).toBe("function");
  });

  test("patchRow predicts the patched row and confirms on its `set` fields", () => {
    const resolved = readLiveEffect(exit.effect).resolve({
      params: { id: "c1" },
      body: undefined,
    });
    expect(resolved.confirmWithinMs).toBeUndefined();
    expect(resolved.targets).toHaveLength(1);
    const t = resolved.targets[0]!;
    if (t.kind !== "row") throw new Error("expected a row target");
    expect(t.subject).toBe("pred_convs");
    expect(t.id).toBe("c1");
    expect(t.set).toEqual({ status: "done", workingOn: null });
    const server = {
      id: "c1",
      status: "working",
      workingOn: "x",
      endedAt: null,
    };
    expect(t.apply(server)).toEqual({
      id: "c1",
      status: "done",
      workingOn: null,
      endedAt: new Date("2026-10-27T00:00:00.000Z"),
    });
    // A row not held predicts nothing.
    expect(t.apply(undefined)).toBeUndefined();
    expect(t.confirmedBy!(server)).toBe(false);
    // `approx` is never compared: the server's own `endedAt` confirms.
    expect(
      t.confirmedBy!({
        ...server,
        status: "done",
        workingOn: null,
        endedAt: new Date("2026-10-27T00:00:09.000Z"),
      }),
    ).toBe(true);
    expect(t.confirmedBy!(undefined)).toBe(false);
  });

  test("effects flattens its parts in order; the tightest deadline wins", () => {
    const live = readLiveEffect(rename.effect);
    expect(live.parts.map((p) => p.kind)).toEqual(["patch", "remove"]);
    const resolved = live.resolve({ params: { id: "c1" }, body: { to: "c2" } });
    expect(resolved.confirmWithinMs).toBe(3000);
    const [patch, remove] = resolved.targets;
    if (patch?.kind !== "row" || remove?.kind !== "row") {
      throw new Error("expected two row targets");
    }
    expect(patch.set).toEqual({ workingOn: "c2" });
    expect(remove.id).toBe("c2");
    expect(remove.set).toBeNull();
    expect(remove.apply({ id: "c2" })).toBeUndefined();
    expect(remove.confirmedBy!(undefined)).toBe(true);
    expect(remove.confirmedBy!({ id: "c2" })).toBe(false);
  });

  test("applyRows hands its reducer the held rows and the request", () => {
    const e = applyRows(
      {} as EffectOn<Record<string, never>, { ids: string[] }>,
      convs,
      ({ body }) => body.ids,
      (rows) => rows.map((r) => ({ ...r, status: "done" })),
    );
    const [t] = readLiveEffect(e as never).resolve({
      params: {},
      body: { ids: ["a", "b"] },
    }).targets;
    if (t?.kind !== "rows") throw new Error("expected a rows target");
    expect(t.ids).toEqual(["a", "b"]);
    expect(t.apply([{ id: "a", status: "working" }])).toEqual([
      { id: "a", status: "done" },
    ]);
  });

  test("a bad id or deadline fails loudly", () => {
    const e = removeRow(anyOn, convs, () => "");
    expect(() =>
      readLiveEffect(e as never).resolve({ params: {}, body: undefined }),
    ).toThrow(/non-empty string id/);
    expect(() =>
      removeRow(anyOn, convs, () => "x", { confirmWithinMs: 0 }),
    ).toThrow(/positive number/);
  });

  test("upsertRow predicts a row from none, compared on `set` when given", () => {
    const e = upsertRow(
      {} as EffectOn<{ id: string }, void>,
      convs,
      ({ params }) => params.id,
      (row, { params }) => ({
        id: params.id,
        status: "working",
        workingOn: row?.workingOn ?? null,
        endedAt: null,
      }),
    );
    const [t] = readLiveEffect(e as never).resolve({
      params: { id: "n" },
      body: undefined,
    }).targets;
    if (t?.kind !== "row") throw new Error("expected a row target");
    expect(t.enters).toBe(true);
    expect(t.confirmedBy).toBeNull();
    expect(t.apply(undefined)).toEqual({
      id: "n",
      status: "working",
      workingOn: null,
      endedAt: null,
    });
  });

  test("choose resolves the request's branch, and refuses one it lacks", () => {
    const on = {} as EffectOn<{ id: string }, { mode: string }>;
    const e = choose(on, ({ body }) => body.mode as "a" | "b", {
      a: removeRow(on, convs, ({ params }) => params.id),
      b: patchRow(
        on,
        convs,
        ({ params }) => params.id,
        () => ({
          set: { status: "done" },
        }),
      ),
    });
    const live = readLiveEffect(e as never);
    expect(live.parts.map((p) => p.kind)).toEqual(["choose"]);
    const a = live.resolve({ params: { id: "x" }, body: { mode: "a" } });
    expect(a.targets[0]).toMatchObject({ kind: "row", removes: true });
    const b = live.resolve({ params: { id: "x" }, body: { mode: "b" } });
    expect(b.targets[0]).toMatchObject({ kind: "row", removes: false });
    expect(() =>
      live.resolve({ params: { id: "x" }, body: { mode: "c" } }),
    ).toThrow(/has no branch/);
  });

  test("lanes: one per target row, deduplicated; a named lane replaces them", () => {
    const on = {} as EffectOn<Record<string, never>, { ids: string[] }>;
    const rows = applyRows(
      on,
      convs,
      ({ body }) => body.ids,
      (r) => r,
    );
    expect(
      readLiveEffect(rows as never).resolve({
        params: {},
        body: { ids: ["b", "a", "b"] },
      }).lanes,
    ).toEqual([
      { kind: "row", subject: "pred_convs", id: "b" },
      { kind: "row", subject: "pred_convs", id: "a" },
    ]);
    const named = applyRows(
      on,
      convs,
      ({ body }) => body.ids,
      (r) => r,
      {
        lane: () => "song:1",
      },
    );
    expect(
      readLiveEffect(named as never).resolve({
        params: {},
        body: { ids: ["a"] },
      }).lanes,
    ).toEqual([{ kind: "named", name: "song:1" }]);
  });

  test("patchWhere / removeWhere carry a canonical filter over the target's fields", () => {
    const on = {} as EffectOn<Record<string, never>, void>;
    const p = patchWhere(
      on,
      convs,
      () => ({ column: "status", op: "eq", operand: "working" }),
      () => ({ status: "done" }),
    );
    const [t] = readLiveEffect(p as never).resolve({
      params: {},
      body: undefined,
    }).targets;
    if (t?.kind !== "where") throw new Error("expected a where target");
    expect(t.apply({ id: "a", status: "working" })).toEqual({
      id: "a",
      status: "done",
    });
    const r = removeWhere(on, convs, () => ({
      column: "nope",
      op: "eq",
      operand: "x",
    }));
    expect(() =>
      readLiveEffect(r as never).resolve({ params: {}, body: undefined }),
    ).toThrow();
  });

  test("patchValue keys its tuple by canonical params", () => {
    const on = {} as EffectOn<{ id: string }, void>;
    const e = patchValue(
      on,
      counter,
      ({ params }) => ({ id: params.id }),
      (v) => ({ n: v.n + 1 }),
    );
    const [t] = readLiveEffect(e as never).resolve({
      params: { id: "x" },
      body: undefined,
    }).targets;
    if (t?.kind !== "value") throw new Error("expected a value target");
    expect(t.key).toBe("pred.counter");
    expect(t.params).toEqual({ id: "x" });
    expect(t.subject).toBe("value:pred.counter");
    expect(t.apply({ n: 1 })).toEqual({ n: 2 });
  });

  test("a `from: null` collection is its own subject", () => {
    const on = {} as EffectOn<{ id: string }, void>;
    const e = removeRow(on, notes, ({ params }) => params.id);
    const [t] = readLiveEffect(e as never).resolve({
      params: { id: "x" },
      body: undefined,
    }).targets;
    expect(t?.subject).toBe("collection:pred.notes");
  });

  test("an exposure target patches the slice its parent's rows carry", () => {
    const on = {} as EffectOn<{ id: string }, void>;
    const plus = applyRows(
      on,
      playback.exposure,
      ({ params }) => [params.id],
      (slices) => slices.map((s) => ({ plays: s.plays + 1 })),
    );
    const [t] = readLiveEffect(plus as never).resolve({
      params: { id: "c1" },
      body: undefined,
    }).targets;
    if (t?.kind !== "rows") throw new Error("expected a rows target");
    expect(t.subject).toBe("pred_convs");
    const held = {
      id: "c1",
      status: "working",
      $columns: { [SLICE]: { plays: 2 } },
    };
    const bare = { id: "c1", status: "working", $columns: {} };
    expect(t.apply([held, bare])).toEqual([
      { id: "c1", status: "working", $columns: { [SLICE]: { plays: 3 } } },
      bare,
    ]);
    const bad = applyRows(
      on,
      playback.exposure,
      () => ["c1"],
      () => [],
    );
    const [b] = readLiveEffect(bad as never).resolve({
      params: { id: "c1" },
      body: undefined,
    }).targets;
    if (b?.kind !== "rows") throw new Error("expected a rows target");
    expect(() => b.apply([held])).toThrow(/one next slice|maps each slice/);

    const set = patchRow(
      on,
      playback.exposure,
      ({ params }) => params.id,
      () => ({
        set: { plays: 5 },
      }),
    );
    const [p] = readLiveEffect(set as never).resolve({
      params: { id: "c1" },
      body: undefined,
    }).targets;
    if (p?.kind !== "row" || p.confirmedBy === null)
      throw new Error("expected a compared row target");
    expect(p.set).toBeNull();
    expect(p.apply(held)).toEqual({
      ...held,
      $columns: { [SLICE]: { plays: 5 } },
    });
    expect(p.apply(bare)).toBe(bare);
    expect(p.confirmedBy(held)).toBe(false);
    expect(
      p.confirmedBy({ ...held, $columns: { [SLICE]: { plays: 5 } } }),
    ).toBe(true);
    // A row carrying no slice cannot disagree.
    expect(p.confirmedBy(bare)).toBe(true);
  });

  test("upsertRows upserts each named row, compared per row", () => {
    const on = {} as EffectOn<
      Record<string, never>,
      { ids: string[]; to: string }
    >;
    const e = upsertRows(
      on,
      notes,
      ({ body }) => body.ids,
      (row, { body }, id) => ({ ...(row ?? { id }), body: body.to }),
      { set: ({ body }, id) => ({ id, body: body.to }) },
    );
    const resolved = readLiveEffect(e as never).resolve({
      params: {},
      body: { ids: ["a", "b"], to: "x" },
    });
    const targets = resolved.targets;
    expect(
      targets.map((t) => (t.kind === "row" ? [t.id, t.enters, t.set] : null)),
    ).toEqual([
      ["a", true, { id: "a", body: "x" }],
      ["b", true, { id: "b", body: "x" }],
    ]);
    const [a] = targets;
    if (a?.kind !== "row") throw new Error("row");
    expect(a.apply(undefined)).toEqual({ id: "a", body: "x" });
    expect(resolved.lanes).toHaveLength(2);
    expect(() =>
      readLiveEffect(e as never).resolve({
        params: {},
        body: { ids: [], to: "x" },
      }),
    ).toThrow(/names no row/);
  });

  test("a where filter may name a collection's key columns", () => {
    const on = {} as EffectOn<{ pageId: string }, void>;
    const e = removeWhere(on, marks, ({ params }) => ({
      column: "pageId",
      op: "eq",
      operand: params.pageId,
    }));
    const [t] = readLiveEffect(e as never).resolve({
      params: { pageId: "p" },
      body: undefined,
    }).targets;
    if (t?.kind !== "where") throw new Error("where");
    expect(Object.keys(t.filterable).sort()).toEqual(["id", "label", "pageId"]);
  });

  test("readLiveEffect refuses an effect it did not build", () => {
    expect(() => readLiveEffect(brandEndpointEffect({}))).toThrow(
      /not built by network\/live/,
    );
  });
});
