/**
 * A declaration that needs the computer (`needsMachine`), read under a
 * transport with none behind it (`machine: false` — an in-browser server):
 * `useLive` / `useLiveRow` answer the `unavailable` arm from the first render
 * and subscribe nothing; under the page's own server (`machine: true`) the
 * same read subscribes as any other. The type checks at the end are tsc's
 * (every `@ts-expect-error` must be an error), in a hook never called.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { renderHook } from "@testing-library/react";
import { z } from "zod";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import {
  createLiveStateHarness,
  NotificationsClient,
} from "@plugins/primitives/plugins/live-state/web/testing";
import type { Transport } from "@plugins/primitives/plugins/networking/web";
import { testTransport } from "@plugins/primitives/plugins/networking/web/testing";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { useLive, useLiveRow, type LiveRowResult } from "../internal/use-live";

const MESSAGE =
  "Reading the checkout isn't available in this version of the app — it needs Singularity running on your computer.";

const ROW_FIELDS = { id: textField({ label: "Id" }) };

let seq = 0;
function machineValue() {
  return liveValue(`test.use-live-machine.value.${seq++}`, {
    schema: z.object({ n: z.number() }),
    needsMachine: { feature: "Reading the checkout" },
  });
}
function machineCollection() {
  return liveCollection(`test.use-live-machine.rows.${seq++}`, {
    fields: ROW_FIELDS,
    id: "id",
    needsMachine: { feature: "Reading the checkout" },
  });
}

/** The harness's pipeline under `transport`. */
function wrapperFor(transport: Transport) {
  return createLiveStateHarness({ transport }).Wrapper;
}

const inBrowser: Transport = testTransport({ machine: false });

describe("useLive of a needsMachine declaration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a paged value and its meta are unavailable too, subscribing nothing", () => {
    const observe = vi.spyOn(NotificationsClient.prototype, "observe");
    const read = renderHook(() => useLive(typedPaged, { dir: "/" }), {
      wrapper: wrapperFor(inBrowser),
    });
    const meta = renderHook(() => useLive(typedPaged.meta, { dir: "/" }), {
      wrapper: wrapperFor(inBrowser),
    });
    expect(read.result.current).toEqual({
      status: "unavailable",
      message: MESSAGE,
    });
    expect(meta.result.current).toEqual({
      status: "unavailable",
      message: MESSAGE,
    });
    expect(
      observe.mock.calls.filter(([key]) => key.startsWith(typedPaged.key)),
    ).toEqual([]);
  });

  it("is unavailable under a transport with no computer, and subscribes nothing", () => {
    const observe = vi.spyOn(NotificationsClient.prototype, "observe");
    const value = machineValue();
    const rows = machineCollection();
    const read = renderHook(() => useLive(value), {
      wrapper: wrapperFor(inBrowser),
    });
    const row = renderHook(() => useLiveRow(rows, "a"), {
      wrapper: wrapperFor(inBrowser),
    });
    expect(read.result.current).toEqual({
      status: "unavailable",
      message: MESSAGE,
    });
    expect(row.result.current).toEqual({
      status: "unavailable",
      message: MESSAGE,
    });
    // Stable: a re-render hands back the same result.
    const first = read.result.current;
    read.rerender();
    expect(read.result.current).toBe(first);
    expect(
      observe.mock.calls.filter(
        ([key]) => key === value.key || key.startsWith(rows.key),
      ),
    ).toEqual([]);
  });

  it("reads as any other declaration under the page's own server", () => {
    const observe = vi.spyOn(NotificationsClient.prototype, "observe");
    const value = machineValue();
    const read = renderHook(() => useLive(value), {
      wrapper: wrapperFor(testTransport()),
    });
    expect(read.result.current.status).toBe("loading");
    expect(
      observe.mock.calls.filter(([key]) => key === value.key).map(([k]) => k),
    ).toEqual([value.key]);
  });
});

const typedValue = liveValue("test.use-live-machine.types.value", {
  schema: z.object({ n: z.number() }),
  needsMachine: { feature: "Reading the checkout" },
});
const portableValue = liveValue("test.use-live-machine.types.portable", {
  schema: z.object({ n: z.number() }),
});
const typedRows = liveCollection("test.use-live-machine.types.rows", {
  fields: ROW_FIELDS,
  id: "id",
  needsMachine: { feature: "Reading the checkout" },
});

const typedPaged = liveValue("test.use-live-machine.types.paged", {
  query: z.object({ dir: z.string() }),
  paged: {
    item: z.object({ name: z.string() }),
    id: "name",
    key: { of: (i) => [i.name], order: ["asc"] },
    limit: 2,
    maxLimit: 4,
    meta: z.object({ total: z.number() }),
  },
  needsMachine: { feature: "Reading the checkout" },
});

function useTypeChecks() {
  // A paged machine value: its pages and its meta sibling both add the arm.
  const pages = useLive(typedPaged, { dir: "/" });
  if (pages.status === "ready") void pages.data;
  // @ts-expect-error a machine paged read may be unavailable: `data` only when ready
  void pages.data;
  const meta = useLive(typedPaged.meta, { dir: "/" });
  // @ts-expect-error a machine meta read may be unavailable: not a ResourceResult
  const asMeta: ResourceResult<{ total: number }> = meta;

  const read = useLive(typedValue);
  // @ts-expect-error a machine read may be unavailable: not a ResourceResult
  const asResult: ResourceResult<{ n: number }> = read;
  if (read.status === "ready") void read.data.n;
  // @ts-expect-error `data` is only on the ready arm — the unavailable one has none
  void read.data;
  if (read.status === "unavailable") void read.message;

  // A portable read's type is unchanged: no unavailable arm.
  const portable: ResourceResult<{ n: number }> = useLive(portableValue);

  const row = useLiveRow(typedRows, "a");
  // @ts-expect-error a machine row read may be unavailable: not a LiveRowResult
  const asRow: LiveRowResult<{ id: string }> = row;
  if (row.status === "ready" && row.found) void row.row.id;
  return [asResult, portable, asRow, asMeta];
}

describe("useLive needsMachine types", () => {
  it("the type assertions above compile", () => {
    expect(typeof useTypeChecks).toBe("function");
  });
});
