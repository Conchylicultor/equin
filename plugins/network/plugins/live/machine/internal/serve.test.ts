/**
 * `live/machine`'s `serveValue` / `serveCollection` serve exactly the
 * declarations `live/server`'s refuse — one declared `needsMachine` — through
 * the same code: each is a tsc error on the other's declaration (every
 * `@ts-expect-error` must be an error), and a machine value registers like any
 * other.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { serveValue as servePortableValue } from "../../server/internal/serve-value";
import { serveCollection as servePortableCollection } from "../../server/internal/serve-collection";
import { serveCollection, serveValue } from "./serve";

const Count = z.object({ n: z.number() });
const FIXED = { fixed: { reason: "a test value" } } as const;

let seq = 0;
const key = (name: string) => `test.live-machine-serve.${name}.${seq++}`;

describe("live/machine serve", () => {
  test("a machine value is served like any other, and declared", async () => {
    const value = liveValue(key("value"), {
      schema: Count,
      needsMachine: { feature: "Counting" },
    });
    expect(value.needsMachine).toEqual({ feature: "Counting" });
    const served = serveValue(value, {
      source: "external",
      changes: FIXED,
      loader: () => ({ n: 1 }),
    });
    expect(served.key).toBe(value.key);
    expect(served.declare).toHaveLength(1);
    expect(await served.load({})).toEqual({ n: 1 });
  });

  test("each barrel's serve is a tsc error on the other's declaration", () => {
    const machine = liveValue(key("types-machine"), {
      schema: Count,
      needsMachine: { feature: "Counting" },
    });
    const portable = liveValue(key("types-portable"), { schema: Count });
    const rows = liveCollection(key("types-rows"), {
      fields: { id: textField({ label: "Id" }) },
      id: "id",
      needsMachine: { feature: "Counting" },
    });
    // Never run: registering would need sources these declarations lack.
    const _checks = () => {
      // @ts-expect-error live/server never serves a needsMachine value
      servePortableValue(machine, {
        source: "external",
        changes: FIXED,
        loader: () => ({ n: 1 }),
      });
      // @ts-expect-error live/machine serves only a needsMachine value
      serveValue(portable, {
        source: "external",
        changes: FIXED,
        loader: () => ({ n: 1 }),
      });
      // @ts-expect-error live/server never serves a needsMachine collection
      servePortableCollection(rows, {
        source: "external",
        changes: FIXED,
        rows: () => [],
      });
      serveCollection(rows, {
        source: "external",
        changes: FIXED,
        rows: () => [],
      });
    };
    expect(typeof _checks).toBe("function");
  });
});
