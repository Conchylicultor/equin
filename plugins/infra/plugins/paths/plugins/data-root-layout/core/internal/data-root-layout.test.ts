import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import {
  DATA_DIR_NAME,
  DataRootSplitError,
  readHomeDataRootLayoutSync,
} from "./data-root-layout";

// The same cases as gateway/dataroot_test.go — the Go gateway resolves its
// default root by the same rule, and the two must agree on every one.

const homes: AppPath[] = [];
function home(): AppPath {
  const dir = asAppPath(mkdtempSync(join(tmpdir(), "data-root-layout-")));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true });
});

const LEGACY = LEGACY_IDS.dataDirName;

describe("readHomeDataRootLayout", () => {
  test("fresh home → the current root", () => {
    const h = home();
    expect(readHomeDataRootLayoutSync(h)).toEqual({
      kind: "current",
      root: joinAppPath(h, DATA_DIR_NAME),
      legacy: joinAppPath(h, LEGACY),
      legacyLink: false,
    });
  });

  test("only the current root → the current root", () => {
    const h = home();
    mkdirSync(joinAppPath(h, DATA_DIR_NAME));
    expect(readHomeDataRootLayoutSync(h).kind).toBe("current");
  });

  test("only the legacy root → the legacy root (not yet migrated)", () => {
    const h = home();
    mkdirSync(joinAppPath(h, LEGACY));
    expect(readHomeDataRootLayoutSync(h)).toEqual({
      kind: "legacy",
      root: joinAppPath(h, LEGACY),
      current: joinAppPath(h, DATA_DIR_NAME),
    });
  });

  test("legacy a link to the current root → the current root, link noted", () => {
    const h = home();
    mkdirSync(joinAppPath(h, DATA_DIR_NAME));
    symlinkSync(DATA_DIR_NAME, joinAppPath(h, LEGACY));
    expect(readHomeDataRootLayoutSync(h)).toEqual({
      kind: "current",
      root: joinAppPath(h, DATA_DIR_NAME),
      legacy: joinAppPath(h, LEGACY),
      legacyLink: true,
    });
  });

  test("legacy a link elsewhere (an external disk) → still the legacy root", () => {
    const h = home();
    mkdirSync(joinAppPath(h, "external"));
    symlinkSync(joinAppPath(h, "external"), joinAppPath(h, LEGACY));
    expect(readHomeDataRootLayoutSync(h).kind).toBe("legacy");
  });

  test("both roots, separate → a split, loudly", () => {
    const h = home();
    mkdirSync(joinAppPath(h, LEGACY));
    mkdirSync(joinAppPath(h, DATA_DIR_NAME));
    expect(() => readHomeDataRootLayoutSync(h)).toThrow(DataRootSplitError);
  });

  test("a dangling legacy link beside no current root → the legacy root", () => {
    // The data is not where the link says; picking the empty current root
    // would read as a fresh install, so the legacy name keeps answering (and
    // fails loudly on its first read).
    const h = home();
    symlinkSync(joinAppPath(h, "gone"), joinAppPath(h, LEGACY));
    expect(readHomeDataRootLayoutSync(h).kind).toBe("legacy");
  });
});
