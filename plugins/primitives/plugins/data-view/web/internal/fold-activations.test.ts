import { describe, expect, test } from "bun:test";
import { foldActivations, type ActivationAnswer } from "./fold-activations";

const union = { key: "t.union", arms: { discriminator: "kind" } };
const link = (href: string) => ({ open: () => {}, href: () => href });

describe("foldActivations — a Meta-DataView dispatches each row to its source", () => {
  test("an arm's activation answers only its own rows", () => {
    const answers: ActivationAnswer[] = [
      {
        id: "open",
        arm: "build",
        resolve: (r) => link(`/b/${(r as { id: string }).id}`),
      },
      { id: "open", arm: "release", resolve: () => undefined },
    ];
    const fold = foldActivations(union, answers);
    const build = fold({ kind: "build", id: "1" });
    expect(
      build !== undefined && typeof build !== "function" && build.href(),
    ).toBe("/b/1");
    // An arm that sends its rows nowhere, and an arm nobody registered.
    expect(fold({ kind: "release", id: "2" })).toBeUndefined();
    expect(fold({ kind: "backup", id: "3" })).toBeUndefined();
  });

  test("a collection's own activation answers every row", () => {
    const fold = foldActivations({ key: "t.plain", arms: null }, [
      { id: "open", arm: null, resolve: () => link("/x") },
    ]);
    expect(fold({ id: "1" })).toBeDefined();
  });

  test("two activations answering one row throw: a row goes one place", () => {
    const fold = foldActivations(union, [
      { id: "a", arm: null, resolve: () => link("/a") },
      { id: "b", arm: "build", resolve: () => link("/b") },
    ]);
    expect(() => fold({ kind: "build" })).toThrow(/a row goes one place/);
  });

  test("an arm's activation on a collection that is no union throws", () => {
    expect(() =>
      foldActivations({ key: "t.plain", arms: null }, [
        { id: "a", arm: "build", resolve: () => undefined },
      ]),
    ).toThrow(/not a union/);
  });
});
