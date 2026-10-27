import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import {
  DATA_DIR_NAME,
  DataRootSplitError,
  readHomeDataRootLayout,
} from "./data-root-layout";

// The same cases as gateway/dataroot_test.go — the Go gateway resolves its
// default root by the same rule, and the two must agree on every one.

const homes: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "data-root-layout-"));
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
    expect(readHomeDataRootLayout(h)).toEqual({
      kind: "current",
      root: join(h, DATA_DIR_NAME),
      legacy: join(h, LEGACY),
      legacyLink: false,
    });
  });

  test("only the current root → the current root", () => {
    const h = home();
    mkdirSync(join(h, DATA_DIR_NAME));
    expect(readHomeDataRootLayout(h).kind).toBe("current");
  });

  test("only the legacy root → the legacy root (not yet migrated)", () => {
    const h = home();
    mkdirSync(join(h, LEGACY));
    expect(readHomeDataRootLayout(h)).toEqual({
      kind: "legacy",
      root: join(h, LEGACY),
      current: join(h, DATA_DIR_NAME),
    });
  });

  test("legacy a link to the current root → the current root, link noted", () => {
    const h = home();
    mkdirSync(join(h, DATA_DIR_NAME));
    symlinkSync(DATA_DIR_NAME, join(h, LEGACY));
    expect(readHomeDataRootLayout(h)).toEqual({
      kind: "current",
      root: join(h, DATA_DIR_NAME),
      legacy: join(h, LEGACY),
      legacyLink: true,
    });
  });

  test("legacy a link elsewhere (an external disk) → still the legacy root", () => {
    const h = home();
    mkdirSync(join(h, "external"));
    symlinkSync(join(h, "external"), join(h, LEGACY));
    expect(readHomeDataRootLayout(h).kind).toBe("legacy");
  });

  test("both roots, separate → a split, loudly", () => {
    const h = home();
    mkdirSync(join(h, LEGACY));
    mkdirSync(join(h, DATA_DIR_NAME));
    expect(() => readHomeDataRootLayout(h)).toThrow(DataRootSplitError);
  });

  test("a dangling legacy link beside no current root → the legacy root", () => {
    // The data is not where the link says; picking the empty current root
    // would read as a fresh install, so the legacy name keeps answering (and
    // fails loudly on its first read).
    const h = home();
    symlinkSync(join(h, "gone"), join(h, LEGACY));
    expect(readHomeDataRootLayout(h).kind).toBe("legacy");
  });
});
