import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  configFileRelPath,
  createMemoryConfigStore,
  parseConfigFile,
  propagateGitLayerDocument,
  type ConfigFileRef,
  type ConfigProxy,
  type JsonValue,
} from "../../core";
import { renderConfigFile } from "./jsonc-proxy";

// The desktop build propagates the committed layer into files; a browser
// host's memory store propagates it into memory. One function, so one result.
describe("propagateGitLayerDocument parity", () => {
  const dir = mkdtempSync(join(tmpdir(), "config-propagate-parity-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("files and memory hold the same documents", async () => {
    const storePath = "p/config.jsonc";
    const doc = {
      base: { a: 2, items: [{ id: "x" }] },
      scopes: { pages: { a: 3, items: [{ id: "x" }] } },
    };
    // The build's file proxy: the file store's own byte format, written
    // synchronously as the build does.
    const fileOf = (ref: ConfigFileRef): ConfigProxy => {
      const path = join(dir, configFileRelPath(ref));
      return {
        read: () =>
          existsSync(path)
            ? parseConfigFile(readFileSync(path, "utf-8"), path)
            : null,
        write: (content, hash) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, renderConfigFile(content, hash), "utf-8");
        },
        exists: () => existsSync(path),
      };
    };
    const OLD_HASH = "0123456789ab";
    // A user override in sync with the old origin: the transition captures it.
    fileOf({ storePath, file: "origin" }).write({ a: 1 }, OLD_HASH);
    fileOf({ storePath, file: "override" }).write({ a: 9 }, OLD_HASH);
    propagateGitLayerDocument(storePath, doc, fileOf);

    // The memory store starts from the same stored layer and propagates on
    // first touch.
    const stored = new Map<
      string,
      { content: JsonValue; hash: string; version: number }
    >([
      [
        `${storePath}\0\0origin`,
        { content: { a: 1 }, hash: OLD_HASH, version: 1 },
      ],
      [
        `${storePath}\0\0override`,
        { content: { a: 9 }, hash: OLD_HASH, version: 2 },
      ],
    ]);
    const memory = createMemoryConfigStore({
      propagatedFrom: () => doc,
      persist: () => ({ loaded: stored, put: () => {}, delete: () => {} }),
    });

    for (const ref of [
      { storePath, file: "origin" },
      { storePath, file: "override" },
      { storePath, file: "ancestor" },
      { storePath, scopeId: "app:pages", file: "origin" },
    ] satisfies ConfigFileRef[]) {
      expect(await memory.read(ref)).toEqual(fileOf(ref).read());
    }
  });
});
