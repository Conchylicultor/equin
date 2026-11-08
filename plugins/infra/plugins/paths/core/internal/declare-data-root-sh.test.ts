import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  DATA_DIR_NAME,
  DataRootSplitError,
  HOME_LAYOUT_TOKENS,
  homeDataRootLayoutOf,
  homeDataRootLayoutToken,
  readHomeDataRootLayoutSync,
} from "./data-root-layout";

// `./equin` decides the layout in shell (scripts/declare-data-root.sh) for the
// whole process tree it starts; the TS decision is the authority. Every home
// shape below must get the same answer from both — a split as "undeclared" in
// shell, which leaves the throw to the CLI's own decision.

const SCRIPT = join(
  REPO_ROOT,
  "plugins/infra/plugins/paths/scripts/declare-data-root.sh",
);
const LEGACY = LEGACY_IDS.dataDirName;

const homes: AppPath[] = [];
function home(): AppPath {
  const dir = asAppPath(mkdtempSync(join(tmpdir(), "declare-data-root-")));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true });
});

function shellToken(h: string, extraEnv: Record<string, string> = {}): string {
  const out = spawnSync(
    "/bin/sh",
    [
      "-c",
      `set -e; . "${SCRIPT}"; printf '%s' "\${${envName("DATA_ROOT_LAYOUT")}:-}"`,
    ],
    { env: { PATH: "/usr/bin:/bin", HOME: h, ...extraEnv }, encoding: "utf8" },
  );
  if (out.status !== 0) throw new Error(`sh failed: ${out.stderr}`);
  return out.stdout;
}

function tsToken(h: string): string {
  try {
    return homeDataRootLayoutToken(readHomeDataRootLayoutSync(h));
  } catch (err) {
    if (err instanceof DataRootSplitError) return "";
    throw err;
  }
}

const SHAPES: Record<string, (h: AppPath) => void> = {
  "fresh home": () => {},
  "only the current root": (h) => mkdirSync(joinAppPath(h, DATA_DIR_NAME)),
  "only the legacy root": (h) => mkdirSync(joinAppPath(h, LEGACY)),
  "legacy a link to the current root": (h) => {
    mkdirSync(joinAppPath(h, DATA_DIR_NAME));
    symlinkSync(DATA_DIR_NAME, joinAppPath(h, LEGACY));
  },
  "legacy a link elsewhere": (h) => {
    mkdirSync(joinAppPath(h, "external"));
    symlinkSync(joinAppPath(h, "external"), joinAppPath(h, LEGACY));
  },
  "both roots, separate": (h) => {
    mkdirSync(joinAppPath(h, LEGACY));
    mkdirSync(joinAppPath(h, DATA_DIR_NAME));
  },
  "a dangling legacy link, no current root": (h) =>
    symlinkSync(joinAppPath(h, "gone"), joinAppPath(h, LEGACY)),
  "a dangling legacy link beside the current root": (h) => {
    mkdirSync(joinAppPath(h, DATA_DIR_NAME));
    symlinkSync(joinAppPath(h, "gone"), joinAppPath(h, LEGACY));
  },
  "the legacy root beside a current link to it": (h) => {
    mkdirSync(joinAppPath(h, LEGACY));
    symlinkSync(LEGACY, joinAppPath(h, DATA_DIR_NAME));
  },
  "the legacy root beside a dangling current link": (h) => {
    mkdirSync(joinAppPath(h, LEGACY));
    symlinkSync(joinAppPath(h, "gone"), joinAppPath(h, DATA_DIR_NAME));
  },
};

describe("declare-data-root.sh agrees with decideDataRootLayout", () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    test(name, () => {
      const h = home();
      shape(h);
      expect(shellToken(h)).toBe(tsToken(h));
    });
  }

  test("an explicit root (DIR) declares nothing", () => {
    const h = home();
    expect(shellToken(h, { [envName("DIR")]: "/somewhere" })).toBe("");
  });

  test("an inherited declaration is replaced, never trusted", () => {
    const h = home();
    expect(shellToken(h, { [envName("DATA_ROOT_LAYOUT")]: "legacy" })).toBe(
      "current",
    );
  });
});

describe("the layout token", () => {
  test("round-trips every home layout", () => {
    const h = home();
    for (const token of HOME_LAYOUT_TOKENS) {
      expect(homeDataRootLayoutToken(homeDataRootLayoutOf(h, token))).toBe(
        token,
      );
    }
  });

  test("names the same layout the disk decides", () => {
    const h = home();
    mkdirSync(joinAppPath(h, DATA_DIR_NAME));
    symlinkSync(DATA_DIR_NAME, joinAppPath(h, LEGACY));
    const decided = readHomeDataRootLayoutSync(h);
    expect(homeDataRootLayoutOf(h, homeDataRootLayoutToken(decided))).toEqual(
      decided,
    );
  });

  test("an unknown token throws", () => {
    expect(() => homeDataRootLayoutOf("/h", "elsewhere")).toThrow(
      /no process tree's root writes/,
    );
  });
});
