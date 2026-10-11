/**
 * C39 (research/2026-10-06-global-scoped-change-routing-p8-v3.md): a key
 * served as a collection's whole ordered set (`liveCollection(key, { all })`)
 * hydrates from the boot snapshot like any default tuple. The boot task
 * resolves each snapshot key through the live-state descriptor registry, so
 * the `all` descriptor must self-register under `key` itself (not only
 * `key:rows`), and its param-less tuple is the one hydrated — the descriptor
 * has no `defaultParams`. The REAL registry and the REAL `hydrateResource`
 * (its payload parse included) run here; only the transport is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { resourceDescriptorByKey } from "@plugins/primitives/plugins/live-state/core";
import type * as LiveStateWeb from "@plugins/primitives/plugins/live-state/web";

const hydrated: { key: string; params: unknown; value: unknown }[] = [];
const reports: { message: string }[] = [];
let snapshot: unknown;

vi.mock("@plugins/infra/plugins/endpoints/web", () => ({
  fetchEndpoint: async () => snapshot,
}));
vi.mock("@plugins/primitives/plugins/perfs/plugins/boot-trace/web", () => ({
  recordBootSpan: () => {},
  markBootInstantAtNextCommit: () => {},
}));
vi.mock("@plugins/reports/web", () => ({
  report: async (r: { message: string }) => {
    reports.push(r);
  },
}));
vi.mock(
  "@plugins/primitives/plugins/live-state/web",
  async (importOriginal) => {
    const actual = await importOriginal<typeof LiveStateWeb>();
    return {
      ...actual,
      // The real hydrate (it parses the payload and seeds the query cache),
      // recorded once it has succeeded.
      hydrateResource: (
        d: Parameters<typeof actual.hydrateResource>[0],
        params: Parameters<typeof actual.hydrateResource>[1],
        value: unknown,
      ) => {
        actual.hydrateResource(d, params, value);
        hydrated.push({ key: d.key, params, value });
      },
    };
  },
);

const { runBootSnapshot } = await import("../internal/boot");

const Row = z.object({ id: z.string(), title: z.string(), rank: z.number() });
const tasks = liveCollection("test.boot.all-tasks", {
  row: Row,
  id: "id",
  all: { orderBy: [["rank", "asc"]], unbounded: { reason: "a boot test" } },
  preload: "boot",
});

describe("boot snapshot hydration of an `all` key (C39)", () => {
  beforeEach(() => {
    hydrated.length = 0;
    reports.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("resolves the key to the `all` descriptor and hydrates its param-less tuple", async () => {
    expect(resourceDescriptorByKey(tasks.key)).toBe(tasks.all);
    expect(tasks.all.defaultParams).toBeUndefined();
    const rows = [
      { id: "a", title: "A", rank: 1 },
      { id: "b", title: "B", rank: 2 },
    ];
    snapshot = {
      resources: { [tasks.key]: rows },
      tuples: {},
      timings: { [tasks.key]: { source: "memory", workMs: 0 } },
    };
    await runBootSnapshot();
    expect(hydrated).toEqual([
      { key: tasks.key, params: undefined, value: rows },
    ]);
    expect(reports).toEqual([]);
  });

  it("a value its row schema rejects is reported and skipped, never hydrated", async () => {
    snapshot = {
      resources: { [tasks.key]: [{ id: "a", title: "A" }] },
      tuples: {},
      timings: {},
    };
    await runBootSnapshot();
    expect(hydrated).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.message).toMatch(
      /hydrate failed for test\.boot\.all-tasks/,
    );
  });
});
