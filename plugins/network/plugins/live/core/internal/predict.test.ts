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
import {
  applyRows,
  effects,
  patchRow,
  readLiveEffect,
  removeRow,
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

function _typeErrors() {
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
  defineEndpoint({
    route: "GET /api/pred/:id",
    // @ts-expect-error — a read declares no effect
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
    expect(t.entity).toBe("pred_convs");
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
    expect(t.confirmedBy(server)).toBe(false);
    // `approx` is never compared: the server's own `endedAt` confirms.
    expect(
      t.confirmedBy({
        ...server,
        status: "done",
        workingOn: null,
        endedAt: new Date("2026-10-27T00:00:09.000Z"),
      }),
    ).toBe(true);
    expect(t.confirmedBy(undefined)).toBe(false);
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
    expect(remove.confirmedBy(undefined)).toBe(true);
    expect(remove.confirmedBy({ id: "c2" })).toBe(false);
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

  test("readLiveEffect refuses an effect it did not build", () => {
    expect(() => readLiveEffect(brandEndpointEffect({}))).toThrow(
      /not built by network\/live/,
    );
  });
});
