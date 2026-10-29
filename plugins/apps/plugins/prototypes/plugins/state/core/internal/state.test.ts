import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { protoIdKind } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { deletePrototype, setPrototypeState } from "./state";

function target(effect: unknown, body: unknown) {
  const [t] = readLiveEffect(effect as never).resolve({
    params: { name: NAME },
    body,
  }).targets;
  if (t === undefined || t.kind !== "row") throw new Error("row target");
  return t;
}

const NAME = protoIdKind.mint();

const row = {
  id: NAME,
  pinned: true,
  done: false,
  tagId: "t",
  deletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("setPrototypeState effect", () => {
  test("sets only the fields given, keeping the rest of a held row", () => {
    const t = target(setPrototypeState.effect, { done: true });
    expect(t.enters).toBe(true);
    expect(t.apply(row)).toMatchObject({
      done: true,
      pinned: true,
      tagId: "t",
    });
  });

  test("a prototype with no row enters with the column defaults", () => {
    const t = target(setPrototypeState.effect, { pinned: true });
    expect(t.apply(undefined)).toMatchObject({
      id: NAME,
      pinned: true,
      done: false,
      tagId: null,
      deletedAt: null,
    });
  });
});

describe("deletePrototype effect", () => {
  test("stamps deletedAt", () => {
    const t = target(deletePrototype.effect, undefined);
    expect(t.apply(row)).toMatchObject({ deletedAt: expect.any(Date) });
  });

  test("the first deletedAt wins", () => {
    const first = new Date(5);
    const t = target(deletePrototype.effect, undefined);
    expect(t.apply({ ...row, deletedAt: first })).toMatchObject({
      deletedAt: first,
    });
  });
});
