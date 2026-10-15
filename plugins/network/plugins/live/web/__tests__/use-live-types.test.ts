/**
 * `useLive`'s overloads, checked by tsc (every `@ts-expect-error` must be an
 * error): a collection's — or a paged value's — paged read with a
 * viewport takes no `limit` (its pages own the limits) and a viewport only as
 * a whole options object — never `undefined` — while a read without one is the
 * plain list read. The cursor chain's `{ first }` is gone, and a key part is
 * text. Nothing here runs: the
 * calls sit in a hook that is never called.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  liveCollection,
  liveValue,
  type LivePagedKey,
} from "@plugins/network/plugins/live/core";
import { useLive } from "../internal/use-live";
import type { LivePagesResult } from "../internal/use-pages";
import type { LiveListResult } from "../internal/use-live";
import { mintVisibleRange } from "../internal/visible-range";

const ROW_FIELDS = {
  id: textField({ label: "Id" }),
  n: intField({ label: "N" }),
};
const Row = fieldsToZodObject(ROW_FIELDS);
type Row = z.infer<typeof Row>;

const windowed = liveCollection("test.use-live-types.window", {
  fields: ROW_FIELDS,
  id: "id",
  sortable: ["n"],
  default: { orderBy: [["n", "asc"]], limit: 2 },
  maxLimit: 4,
});
const lookup = liveCollection("test.use-live-types.lookup", {
  fields: ROW_FIELDS,
  id: "id",
});
const viewport = mintVisibleRange({ kind: "measuring" });

const Item = z.object({ id: z.string(), at: z.string(), n: z.number() });
type Item = z.infer<typeof Item>;
const Question = z.object({ metric: z.string() });
const pagedValue = liveValue("test.use-live-types.paged", {
  query: Question,
  paged: {
    item: Item,
    id: "id",
    key: { of: (i) => [i.at], order: ["desc"] },
    limit: 2,
    maxLimit: 4,
    meta: z.object({ total: z.number() }),
  },
});
const refusingPaged = liveValue("test.use-live-types.paged-refusals", {
  query: Question,
  paged: {
    item: Item,
    id: "id",
    key: { of: (i) => [i.at], order: ["desc"] },
    limit: 2,
    maxLimit: 4,
    meta: z.object({ total: z.number() }),
  },
  refusals: ["invalid-query"],
});

function useTypeChecks(maybe: { viewport: typeof viewport } | undefined) {
  const paged: LivePagesResult<Row> = useLive(windowed, {}, { viewport });
  const detached: LivePagesResult<Row> = useLive(null, null, { viewport });
  const list: LiveListResult<Row> = useLive(windowed, { limit: 1 });

  // @ts-expect-error a paged read's pages own the limits
  useLive(windowed, { limit: 1 }, { viewport });
  // @ts-expect-error a lookup-only collection has no window to page
  useLive(lookup, {}, { viewport });
  // @ts-expect-error a viewport is the options object, never `undefined`
  useLive(windowed, {}, maybe);
  // @ts-expect-error the viewport is a branded VisibleRange, never spelled by hand
  useLive(windowed, {}, { viewport: { kind: "measuring" } });

  const valuePages: LivePagesResult<Item> = useLive(
    pagedValue,
    { metric: "m" },
    { viewport },
  );
  const valueList: LiveListResult<Item> = useLive(pagedValue, { metric: "m" });
  const preview: LiveListResult<Item> = useLive(
    pagedValue,
    { metric: "m" },
    { limit: 1 },
  );
  const total = useLive(pagedValue.meta, { metric: "m" });
  // A declared refusal types the pages' and the meta sibling's error code alike.
  const refusedPages = useLive(refusingPaged, { metric: "m" });
  if (refusedPages.status === "error") {
    const code: "invalid-query" | undefined = refusedPages.error.code;
    void code;
  }
  const refusedTotal = useLive(refusingPaged.meta, { metric: "m" });
  if (refusedTotal.status === "error") {
    const code: "invalid-query" | undefined = refusedTotal.error.code;
    void code;
    // @ts-expect-error — "gone" is not one of the declared codes
    void (refusedTotal.error.code === "gone");
  }
  // @ts-expect-error a paged read under a viewport takes no limit
  useLive(pagedValue, { metric: "m" }, { viewport, limit: 1 });
  // @ts-expect-error the cursor chain's `first` is gone — a preview is `{ limit }`
  useLive(pagedValue, { metric: "m" }, { first: 1 });
  // @ts-expect-error a viewport is the options object, never `undefined`
  useLive(pagedValue, { metric: "m" }, maybe);
  // @ts-expect-error the question is the schema's input
  useLive(pagedValue, { q: "{}" });
  return [
    paged,
    detached,
    list,
    valuePages,
    valueList,
    preview,
    total,
    refusedPages,
    refusedTotal,
  ];
}

/** A paged value's key, checked by tsc (its serve half: `core/internal/compile-value.test.ts`). */
function declarationChecks() {
  const key: LivePagedKey<Item> = {
    // @ts-expect-error a key part is exact text (or null), never a number
    of: (i) => [i.n],
    order: ["asc"],
  };
  return key;
}

describe("useLive's overloads", () => {
  it("are checked by tsc (see the @ts-expect-error lines)", () => {
    expect(typeof useTypeChecks).toBe("function");
    expect(typeof declarationChecks).toBe("function");
  });
});
