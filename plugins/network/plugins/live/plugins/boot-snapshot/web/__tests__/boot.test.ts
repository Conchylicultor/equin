/**
 * The boot snapshot's client half: every default-tuple resource and every
 * enumerated tuple is hydrated before first paint, each in isolation — one
 * entry its client schema rejects is reported and skipped, never the end of
 * hydration for the entries after it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hydrated: [string, unknown, unknown][] = [];
const reports: { message: string }[] = [];
let snapshot: unknown;
let pageFetches = 0;

vi.mock(
  "@plugins/primitives/plugins/networking/plugins/page-transport/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    pageTransport: {
      fetch: async () => {
        pageFetches += 1;
        return Response.json(snapshot);
      },
    },
  }),
);
vi.mock(
  "@plugins/primitives/plugins/perfs/plugins/boot-trace/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    recordBootSpan: () => {},
    markBootInstantAtNextCommit: () => {},
  }),
);
vi.mock("@plugins/reports/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  report: async (r: { message: string }) => {
    reports.push(r);
  },
}));
vi.mock(
  "@plugins/network/plugins/live/plugins/live-state/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    resourceDescriptorByKey: (key: string) =>
      key === "unknown" ? undefined : { key, defaultParams: undefined },
    hydrateResource: (d: { key: string }, params: unknown, value: unknown) => {
      if (value === "BAD") throw new Error("schema rejected");
      hydrated.push([d.key, params, value]);
    },
  }),
);

const { runBootSnapshot } = await import("../internal/boot");
const { HEAD_REQUEST_GLOBAL } = await import("../../shared/head-request");

describe("boot snapshot hydration", () => {
  beforeEach(() => {
    hydrated.length = 0;
    reports.length = 0;
    pageFetches = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("hydrates default tuples and every enumerated tuple with its params", async () => {
    snapshot = {
      resources: { plain: 1 },
      tuples: {
        docs: [
          { params: { path: "a" }, value: 2 },
          { params: { path: "a", scopeId: "s" }, value: 3 },
        ],
      },
      timings: {},
    };
    await runBootSnapshot();
    expect(hydrated).toEqual([
      ["plain", undefined, 1],
      ["docs", { path: "a" }, 2],
      ["docs", { path: "a", scopeId: "s" }, 3],
    ]);
    expect(reports).toEqual([]);
  });

  it("a rejected entry is reported and skipped; the entries after it still hydrate", async () => {
    snapshot = {
      resources: { broken: "BAD", plain: 1 },
      tuples: {
        docs: [
          { params: { path: "a" }, value: "BAD" },
          { params: { path: "b" }, value: 4 },
        ],
      },
      timings: {},
    };
    await runBootSnapshot();
    expect(hydrated).toEqual([
      ["plain", undefined, 1],
      ["docs", { path: "b" }, 4],
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.message).toMatch(/hydrate failed for broken .*docs/);
  });

  it("an unresolved key is reported, enumerated or not", async () => {
    snapshot = {
      resources: {},
      tuples: { unknown: [{ params: { id: "x" }, value: 1 }] },
      timings: {},
    };
    await runBootSnapshot();
    expect(hydrated).toEqual([]);
    expect(reports[0]!.message).toMatch(
      /unresolved descriptor key\(s\): unknown/,
    );
  });

  it("reads the request the shell's head started, once; a second boot asks afresh", async () => {
    snapshot = { resources: { plain: 1 }, tuples: {}, timings: {} };
    Reflect.set(globalThis, HEAD_REQUEST_GLOBAL, {
      response: Promise.resolve(
        Response.json({ resources: { early: 0 }, tuples: {}, timings: {} }),
      ),
      startMs: 0,
    });
    await runBootSnapshot();
    expect(pageFetches).toBe(0);
    expect(hydrated).toEqual([["early", undefined, 0]]);
    expect(Reflect.get(globalThis, HEAD_REQUEST_GLOBAL)).toBeUndefined();

    await runBootSnapshot();
    expect(pageFetches).toBe(1);
    expect(hydrated).toEqual([
      ["early", undefined, 0],
      ["plain", undefined, 1],
    ]);
  });

  it("a head request that failed fails the boot task", async () => {
    Reflect.set(globalThis, HEAD_REQUEST_GLOBAL, {
      response: Promise.reject(new TypeError("Failed to fetch")),
      startMs: 0,
    });
    await expect(runBootSnapshot()).rejects.toThrow("Failed to fetch");
    expect(pageFetches).toBe(0);
  });
});
