import {
  readEnv,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { withHostServices } from "@plugins/framework/plugins/server-core/core/testing";
import { DeploySecretSource } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/server";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserConfigFile } from "./browser-config-file";
import {
  clearBrowserConfig,
  writeBrowserKey,
  writeMapId,
} from "./browser-config-store";

// Hermetic: the host-global file lives under a throwaway data root.
const ORIGINAL_DATA_ROOT = readEnv("DIR");
const dataRoot = mkdtempSync(
  join(tmpdir(), "google-maps-browser-config-file-"),
);
setEnv("DIR", dataRoot);
afterAll(async () => {
  await clearBrowserConfig();
  if (ORIGINAL_DATA_ROOT === undefined) unsetEnv("DIR");
  else setEnv("DIR", ORIGINAL_DATA_ROOT);
  rmSync(dataRoot, { recursive: true, force: true });
});

const KEY = `AIza${"k".repeat(35)}`;
const FILE_KEY = `AIza${"f".repeat(35)}`;

/** A box whose credentials directory holds exactly `secrets`. */
function onBox<T>(
  secrets: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  return withHostServices(
    [
      DeploySecretSource.provide({
        read: (key) =>
          Promise.resolve(
            key in secrets
              ? { kind: "set", value: secrets[key]! }
              : { kind: "unset" },
          ),
      }),
    ],
    fn,
  );
}

test("a box with the key and a Map ID draws the vector map", async () => {
  expect(
    await onBox(
      {
        GOOGLE_MAPS_BROWSER_KEY: KEY,
        GOOGLE_MAPS_MAP_ID: " f27dbc20ea7be2e0 ",
      },
      () => browserConfigFile.read(),
    ),
  ).toEqual({ kind: "set", browserKey: KEY, mapId: "f27dbc20ea7be2e0" });
});

test("a box with the key alone draws the raster map, whatever the file holds", async () => {
  await writeBrowserKey(FILE_KEY);
  await writeMapId("filemapid123");
  expect(
    await onBox({ GOOGLE_MAPS_BROWSER_KEY: KEY }, () =>
      browserConfigFile.read(),
    ),
  ).toEqual({ kind: "set", browserKey: KEY, mapId: null });
});

test("a deployed Map ID that is not one throws", () => {
  expect(
    onBox(
      { GOOGLE_MAPS_BROWSER_KEY: KEY, GOOGLE_MAPS_MAP_ID: "not a map id!" },
      () => browserConfigFile.read(),
    ),
  ).rejects.toThrow("is not a Map ID");
});

test("a deployed Map ID with no deployed key throws", () => {
  expect(
    onBox({ GOOGLE_MAPS_MAP_ID: "f27dbc20ea7be2e0" }, () =>
      browserConfigFile.read(),
    ),
  ).rejects.toThrow("set without GOOGLE_MAPS_BROWSER_KEY");
});

test("no deploy secret: the computer's file answers", async () => {
  await writeBrowserKey(FILE_KEY);
  await writeMapId("filemapid123");
  expect(await onBox({}, () => browserConfigFile.read())).toEqual({
    kind: "set",
    browserKey: FILE_KEY,
    mapId: "filemapid123",
  });
});
