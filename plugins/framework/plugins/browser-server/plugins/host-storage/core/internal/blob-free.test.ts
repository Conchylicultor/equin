import { describe, expect, test } from "bun:test";
import { assertStoreValue, memoryHostStorage } from "./host-storage";

// WebKit's IndexedDB cannot store a Blob from a worker, so a host store holds
// bytes: refused at compile time where the type says so, at runtime always.
describe("a host store value never holds a Blob", () => {
  const storage = memoryHostStorage();
  const same = { shiftTime: <V>(v: V) => v };

  test("the type refuses a Blob, alone or inside a value", () => {
    storage.store<Uint8Array>("bytes", same);
    storage.store<{ kind: "file"; bytes: Uint8Array } | { kind: "dir" }>(
      "nodes",
      same,
    );
    // @ts-expect-error -- a Blob
    storage.store<Blob>("blob", same);
    // @ts-expect-error -- a Blob in one member of a union
    storage.store<{ kind: "file"; blob: Blob } | { kind: "dir" }>(
      "blob-nodes",
      same,
    );
  });

  test("put refuses a Blob wherever it sits", () => {
    const store = storage.store<unknown>("loose", same);
    expect(() =>
      store.put("k", { files: [new Blob([new Uint8Array([1])])] }),
    ).toThrow(/k\.files\[0\] is a Blob/);
    store.put("k", { files: [new Uint8Array([1])], n: 1 });
  });

  test("bytes and plain data pass", () => {
    assertStoreValue({ a: [1, "x", null], b: new Uint8Array([2]) }, "v");
  });
});
