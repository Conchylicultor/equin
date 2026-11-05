import { describe, expect, test } from "bun:test";
import {
  HOST_PATHS_MIME,
  handOffHostPaths,
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

describe("a drag handed off to the OS", () => {
  test("reads back as host paths until the next drag, as a Files drag only", async () => {
    const entries = [{ path: "/a/b.mp4", kind: "file" as const }];
    let end: (outcome: string) => void = () => {};
    const ended = handOffHostPaths(
      entries,
      (paths) =>
        new Promise<string>((resolve) => {
          expect(paths).toEqual(["/a/b.mp4"]);
          end = resolve;
        }),
    );
    const files = { types: ["Files"], getData: () => "" };
    expect(hasHostPaths(files.types)).toBe(true);
    expect(readHostPaths(files)).toEqual({ kind: "paths", entries });
    // Another kind of drag is not it.
    expect(hasHostPaths(["text/plain"])).toBe(false);
    end("dropped");
    expect(await ended).toBe("dropped");
    // Its drop on this page may still be on its way after its end…
    expect(readHostPaths(files)).toEqual({ kind: "paths", entries });
    // …until another drag enters: files are files from outside again.
    globalThis.dispatchEvent(new Event("dragenter"));
    expect(hasHostPaths(files.types)).toBe(false);
    expect(readHostPaths(files)).toEqual({ kind: "absent" });
  });
});
