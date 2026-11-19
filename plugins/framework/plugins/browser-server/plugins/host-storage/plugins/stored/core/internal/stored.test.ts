import { afterEach, describe, expect, it } from "bun:test";
import { hostDataStored } from "./stored";

// A browser refusing the page IndexedDB (Firefox with cookies and site data
// blocked: report-1795106221-2g722h) throws a SecurityError from
// `indexedDB.databases()` — synchronously, before any promise exists.
const g = globalThis as { indexedDB?: unknown };

afterEach(() => {
  delete g.indexedDB;
});

describe("hostDataStored", () => {
  it("answers blocked where the browser refuses IndexedDB, never rejects", async () => {
    g.indexedDB = {
      databases: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    };
    expect(await hostDataStored("demo")).toEqual({
      kind: "blocked",
      error: "SecurityError",
    });
  });

  it("answers absent where the page has no IndexedDB, or lists no such database", async () => {
    expect(await hostDataStored("demo")).toEqual({ kind: "absent" });
    g.indexedDB = { databases: () => Promise.resolve([]) };
    expect(await hostDataStored("demo")).toEqual({ kind: "absent" });
  });

  it("rejects any other failure", () => {
    g.indexedDB = {
      databases: () => Promise.reject(new TypeError("boom")),
    };
    expect(hostDataStored("demo")).rejects.toThrow("boom");
  });
});
