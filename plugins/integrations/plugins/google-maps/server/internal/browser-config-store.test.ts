import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearBrowserConfig,
  clearMapId,
  NoBrowserKeyError,
  readBrowserConfig,
  writeBrowserKey,
  writeMapId,
} from "./browser-config-store";

// Hermetic: the data root (read per call) points at a throwaway dir, so the
// host's real browser-config.json is never touched.
const ORIGINAL_DATA_ROOT = process.env.SINGULARITY_DIR;
const dataRoot = mkdtempSync(join(tmpdir(), "google-maps-browser-config-"));
process.env.SINGULARITY_DIR = dataRoot;

afterAll(() => {
  if (ORIGINAL_DATA_ROOT === undefined) delete process.env.SINGULARITY_DIR;
  else process.env.SINGULARITY_DIR = ORIGINAL_DATA_ROOT;
  rmSync(dataRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearBrowserConfig();
});

const KEY = `AIza${"a".repeat(35)}`;
const OTHER_KEY = `AIza${"b".repeat(35)}`;

test("no file is unset", async () => {
  expect(await readBrowserConfig()).toEqual({ kind: "unset" });
});

test("a key alone has no Map ID", async () => {
  await writeBrowserKey(KEY);
  expect(await readBrowserConfig()).toEqual({
    kind: "set",
    browserKey: KEY,
    mapId: null,
  });
});

test("a Map ID without a key is refused", async () => {
  const refused = await writeMapId("8e0a97af9386fef").then(
    () => null,
    (err: unknown) => err,
  );
  expect(refused).toBeInstanceOf(NoBrowserKeyError);
  expect(await readBrowserConfig()).toEqual({ kind: "unset" });
});

test("a new key keeps the Map ID; clearing the Map ID keeps the key", async () => {
  await writeBrowserKey(KEY);
  await writeMapId("8e0a97af9386fef");
  await writeBrowserKey(OTHER_KEY);
  expect(await readBrowserConfig()).toEqual({
    kind: "set",
    browserKey: OTHER_KEY,
    mapId: "8e0a97af9386fef",
  });
  await clearMapId();
  expect(await readBrowserConfig()).toEqual({
    kind: "set",
    browserKey: OTHER_KEY,
    mapId: null,
  });
});

test("removing the browser config removes both", async () => {
  await writeBrowserKey(KEY);
  await writeMapId("8e0a97af9386fef");
  await clearBrowserConfig();
  expect(await readBrowserConfig()).toEqual({ kind: "unset" });
});
