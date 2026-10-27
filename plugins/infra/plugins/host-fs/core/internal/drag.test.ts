import { describe, expect, test } from "bun:test";
import {
  HOST_PATHS_MIME,
  hasHostPaths,
  readHostPaths,
  writeHostPaths,
} from "./drag";

/** The slice of a DataTransfer the helpers touch. */
function transfer(data: Record<string, string> = {}) {
  return {
    setData: (type: string, value: string) => {
      data[type] = value;
    },
    getData: (type: string) => data[type] ?? "",
    get types() {
      return Object.keys(data);
    },
  };
}

describe("host paths drag payload", () => {
  test("round-trips through a DataTransfer", () => {
    const dt = transfer();
    const entries = [
      { path: "/a/b.txt", kind: "file" as const },
      { path: "/a/c", kind: "dir" as const },
    ];
    writeHostPaths(dt, entries);
    expect(hasHostPaths(dt.types)).toBe(true);
    expect(readHostPaths(dt)).toEqual({ kind: "paths", entries });
  });

  test("a drag without the type is absent", () => {
    const dt = transfer({ "text/plain": "hello" });
    expect(hasHostPaths(dt.types)).toBe(false);
    expect(readHostPaths(dt)).toEqual({ kind: "absent" });
  });

  test("a payload that does not decode is malformed", () => {
    expect(readHostPaths(transfer({ [HOST_PATHS_MIME]: "{" }))).toMatchObject({
      kind: "malformed",
    });
    expect(
      readHostPaths(transfer({ [HOST_PATHS_MIME]: '{"entries":[]}' })),
    ).toMatchObject({ kind: "malformed" });
    // An entry with no kind: every writer says what it drags.
    expect(
      readHostPaths(
        transfer({ [HOST_PATHS_MIME]: '{"entries":[{"path":"/a"}]}' }),
      ),
    ).toMatchObject({ kind: "malformed" });
  });

  test("writing no paths throws", () => {
    expect(() => writeHostPaths(transfer(), [])).toThrow();
  });
});
