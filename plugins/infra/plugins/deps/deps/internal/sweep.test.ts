import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { defineDep } from "./dep";
import { releaseLock, tryLock } from "./lock";
import { identityOf, installPaths, type DepStore } from "./store";
import { SWEEP_IDLE_MS, sweepDeps } from "./sweep";

let base: AppPath;
let store: DepStore;

beforeEach(() => {
  base = asAppPath(mkdtempSync(join(tmpdir(), "deps-sweep-")));
  store = {
    cacheRoot: joinAppPath(base, "cache"),
    locksRoot: joinAppPath(base, "locks"),
  };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const NOW = new Date("2026-09-29T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** A dep whose identity depends on which checkout it is read from. */
const dep = defineDep({
  id: "swept",
  owner: "infra/deps",
  description: "",
  sizeHint: "",
  source: {
    kind: "fake",
    label: "",
    identityInputs: async (root: string) => {
      if (root.endsWith("broken")) throw new Error("no installer here");
      return { root: root.endsWith("wt") ? "trial" : "main" };
    },
    install: async () => {},
  },
  updates: { none: "a test fixture" },
});

function install(identity: string, lastUsedDaysAgo: number): string {
  const paths = installPaths(store, dep.id, identity);
  mkdirSync(paths.env, { recursive: true });
  writeFileSync(paths.ready, "{}");
  writeFileSync(
    paths.lastUsed,
    new Date(NOW.getTime() - lastUsedDaysAgo * DAY).toISOString(),
  );
  return paths.root;
}

test("keeps current and recently used identities, removes the rest unless locked", async () => {
  const mainId = identityOf("fake", { root: "main" });
  const trialId = identityOf("fake", { root: "trial" });
  const current = install(mainId, 60); // current for main, however old
  const trial = install(trialId, 60); // current for the worktree checkout
  const recent = install("recent0000000000", 3); // declared by nobody, used lately
  const stale = install("stale00000000000", 30); // declared by nobody, idle
  const locked = install("locked0000000000", 30); // idle, but held right now
  const orphan = join(store.cacheRoot, "gone-dep", "old0000000000000");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(
    join(orphan, "last-used"),
    new Date(NOW.getTime() - 90 * DAY).toISOString(),
  );

  const fd = tryLock(installPaths(store, dep.id, "locked0000000000").lock);
  const report = await sweepDeps({
    store,
    deps: [dep],
    checkouts: [
      asAppPath("/repo/main"),
      asAppPath("/repo/wt"),
      asAppPath("/repo/broken"),
    ],
    now: NOW,
    idleMs: SWEEP_IDLE_MS,
  });
  releaseLock(fd as number);

  expect(existsSync(current)).toBe(true);
  expect(existsSync(trial)).toBe(true);
  expect(existsSync(recent)).toBe(true);
  expect(existsSync(locked)).toBe(true);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(orphan)).toBe(false);
  expect(report.removed.sort()).toEqual([
    "gone-dep/old0000000000000",
    "swept/stale00000000000",
  ]);
  expect(report.underivable).toHaveLength(1);
  expect(report.underivable[0]).toContain("no installer here");
});
