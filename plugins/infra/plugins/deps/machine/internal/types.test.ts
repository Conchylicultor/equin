import { describe, expect, test } from "bun:test";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { installDepEndpoint } from "../../core";
import { defineDep, ensureDep, type DepSource } from "../../deps";

const frozenSource: DepSource<"fake"> = {
  kind: "fake",
  label: "",
  identityInputs: async () => ({}),
  install: async () => {},
};

const dep = defineDep({
  id: "typed",
  owner: "infra/deps",
  description: "",
  sizeHint: "",
  source: frozenSource,
  updates: { none: "a type-level fixture" },
});

describe("the ExecContext rule, at the type level", () => {
  test("a request handler cannot call ensureDep", () => {
    // Never invoked: the assertion is that tsc rejects each marked line.
    const handler = implementMachine(installDepEndpoint, async ({ body }) => {
      // @ts-expect-error — a request handler has no ExecContext to pass.
      await ensureDep(dep, {});
      // @ts-expect-error — nor can it forge one: the brand is module-private.
      await ensureDep(dep, { origin: "cli" });
      return { id: body.id };
    });
    expect(typeof handler).toBe("function");
  });

  test("a source with no updater must say why it is frozen", () => {
    expect(() =>
      // @ts-expect-error — `updates: { none }` is required without an updater.
      defineDep({
        id: "unstated",
        owner: "infra/deps",
        description: "",
        sizeHint: "",
        source: frozenSource,
      }),
    ).toThrow("must say why it is frozen");
  });

  test("a source with an updater may not also claim to be frozen", () => {
    const moving = { ...frozenSource, updater: "uv" } as const;
    const d = defineDep({
      id: "moving",
      owner: "infra/deps",
      description: "",
      sizeHint: "",
      source: moving,
    });
    expect(d.updates).toEqual({ kind: "updater", updater: "uv" });
    defineDep({
      id: "moving-2",
      owner: "infra/deps",
      description: "",
      sizeHint: "",
      source: moving,
      // @ts-expect-error — the updater already says how it stays current.
      updates: { none: "contradiction" },
    });
  });

  test("an id that cannot name a directory is refused", () => {
    expect(() =>
      defineDep({
        id: "Bad/Id",
        owner: "infra/deps",
        description: "",
        sizeHint: "",
        source: frozenSource,
        updates: { none: "x" },
      }),
    ).toThrow("must match");
  });
});
