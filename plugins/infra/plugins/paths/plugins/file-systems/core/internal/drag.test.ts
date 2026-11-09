import { describe, expect, test } from "bun:test";
import {
  FILE_LOCATIONS_MIME,
  handOffComputerFiles,
  hasFileLocations,
  readFileLocations,
  writeFileLocations,
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

describe("file locations drag payload", () => {
  test("round-trips through a DataTransfer", () => {
    const dt = transfer();
    const entries = [
      { path: "/a/b.txt", kind: "file" as const },
      { path: "/a/c", kind: "dir" as const },
    ];
    writeFileLocations(dt, "browser", entries);
    expect(hasFileLocations(dt.types)).toBe(true);
    expect(readFileLocations(dt)).toEqual({
      kind: "files",
      fs: "browser",
      entries,
    });
  });

  test("a drag without the type is absent", () => {
    const dt = transfer({ "text/plain": "hello" });
    expect(hasFileLocations(dt.types)).toBe(false);
    expect(readFileLocations(dt)).toEqual({ kind: "absent" });
  });

  test("a payload that does not decode is malformed", () => {
    expect(
      readFileLocations(transfer({ [FILE_LOCATIONS_MIME]: "{" })),
    ).toMatchObject({
      kind: "malformed",
    });
    expect(
      readFileLocations(
        transfer({ [FILE_LOCATIONS_MIME]: '{"fs":"browser","entries":[]}' }),
      ),
    ).toMatchObject({ kind: "malformed" });
    // An entry with no kind: every writer says what it drags.
    expect(
      readFileLocations(
        transfer({
          [FILE_LOCATIONS_MIME]: '{"fs":"browser","entries":[{"path":"/a"}]}',
        }),
      ),
    ).toMatchObject({ kind: "malformed" });
  });

  test("writing no paths throws", () => {
    expect(() => writeFileLocations(transfer(), "computer", [])).toThrow();
  });
});

describe("a drag handed off to the OS", () => {
  test("reads back as computer files until the next drag, as a Files drag only", async () => {
    const entries = [{ path: "/a/b.mp4", kind: "file" as const }];
    let end: (outcome: string) => void = () => {};
    const ended = handOffComputerFiles(
      entries,
      (paths) =>
        new Promise<string>((resolve) => {
          expect(paths).toEqual(["/a/b.mp4"]);
          end = resolve;
        }),
    );
    const files = { types: ["Files"], getData: () => "" };
    expect(hasFileLocations(files.types)).toBe(true);
    expect(readFileLocations(files)).toEqual({
      kind: "files",
      fs: "computer",
      entries,
    });
    // Another kind of drag is not it.
    expect(hasFileLocations(["text/plain"])).toBe(false);
    end("dropped");
    expect(await ended).toBe("dropped");
    // Its drop on this page may still be on its way after its end…
    expect(readFileLocations(files)).toEqual({
      kind: "files",
      fs: "computer",
      entries,
    });
    // …until another drag enters: files are files from outside again.
    globalThis.dispatchEvent(new Event("dragenter"));
    expect(hasFileLocations(files.types)).toBe(false);
    expect(readFileLocations(files)).toEqual({ kind: "absent" });
  });
});
