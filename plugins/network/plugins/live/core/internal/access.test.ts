import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { resourceDescriptorByKey } from "@plugins/network/plugins/live/plugins/live-state/core";
import { liveCollection } from "./live-collection";
import { liveValue } from "./live-value";

const F = {
  id: textField({ label: "Id" }),
  n: intField({ label: "N" }),
};
const access = { visitor: "the site's home page reads it" };

describe("access — on the descriptor the runtime registers", () => {
  test("a value carries it; absent means the owner only", () => {
    const open = liveValue("test.access.value", { schema: z.number(), access });
    expect(resourceDescriptorByKey("test.access.value")?.access).toEqual(
      access,
    );
    expect(open.access).toEqual(access);
    liveValue("test.access.value-owner", { schema: z.number() });
    expect(
      resourceDescriptorByKey("test.access.value-owner")?.access,
    ).toBeUndefined();
  });

  test("a window collection stamps every descriptor it mints", () => {
    liveCollection("test.access.window", {
      fields: F,
      id: "id",
      sortable: ["n"],
      default: { orderBy: [["n", "asc"]], limit: 10 },
      maxLimit: 50,
      count: true,
      access,
    });
    for (const k of ["", ":rows", ":groups", ":count"]) {
      expect(resourceDescriptorByKey(`test.access.window${k}`)?.access).toEqual(
        access,
      );
    }
  });

  test("an `all` set and a lookup-only collection stamp theirs", () => {
    liveCollection("test.access.all", {
      fields: F,
      id: "id",
      all: { orderBy: [["n", "asc"]], max: 10 },
      access,
    });
    liveCollection("test.access.lookup", { fields: F, id: "id", access });
    for (const k of [
      "test.access.all",
      "test.access.all:rows",
      "test.access.lookup:rows",
    ]) {
      expect(resourceDescriptorByKey(k)?.access).toEqual(access);
    }
  });

  test("anything but { visitor: <non-empty reason> } throws at declaration", () => {
    for (const bad of [
      { visitor: "" },
      { visitor: "  " },
      { public: "x" },
      "owner",
    ]) {
      expect(() =>
        liveValue(`test.access.bad-${JSON.stringify(bad)}`, {
          schema: z.number(),
          access: bad as never,
        }),
      ).toThrow(/`access` is \{ visitor/);
    }
  });
});
