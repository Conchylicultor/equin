import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configFileRelPath,
  createMemoryConfigStore,
  propagateGitLayerDocument,
  type ConfigFileRef,
} from "../../core";
import { jsoncConfigProxy } from "./jsonc-proxy";

// The desktop build propagates the committed layer into files; a browser
// host's memory store propagates it into memory. One function, so one result.
describe("propagateGitLayerDocument parity", () => {
  const dir = mkdtempSync(join(tmpdir(), "config-propagate-parity-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("files and memory hold the same documents", () => {
    const storePath = "p/config.jsonc";
    const doc = {
      base: { a: 2, items: [{ id: "x" }] },
      scopes: { pages: { a: 3, items: [{ id: "x" }] } },
    };
    const fileOf = (ref: ConfigFileRef) =>
      jsoncConfigProxy(join(dir, configFileRelPath(ref)));
    const OLD_HASH = "0123456789ab";
    // A user override in sync with the old origin: the transition captures it.
    fileOf({ storePath, file: "origin" }).write({ a: 1 }, OLD_HASH);
    fileOf({ storePath, file: "override" }).write({ a: 9 }, OLD_HASH);
    const memory = createMemoryConfigStore();
    memory.proxy({ storePath, file: "origin" }).write({ a: 1 }, OLD_HASH);
    memory.proxy({ storePath, file: "override" }).write({ a: 9 }, OLD_HASH);

    const fromFiles = propagateGitLayerDocument(storePath, doc, fileOf);
    const fromMemory = propagateGitLayerDocument(storePath, doc, (ref) =>
      memory.proxy(ref),
    );
    expect(fromMemory).toEqual(fromFiles);
    for (const ref of [
      { storePath, file: "origin" },
      { storePath, file: "override" },
      { storePath, file: "ancestor" },
      { storePath, scopeId: "app:pages", file: "origin" },
    ] satisfies ConfigFileRef[]) {
      expect(memory.proxy(ref).read()).toEqual(fileOf(ref).read());
    }
  });
});
