import { describe, expect, test } from "bun:test";
import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { relayIntoSlot, type SlotRelayDeps } from "./slot-relay";

const SERVED_SLOT = asAppPath("/data/services/main-slots/slot-1");
const FREE_SLOT = asAppPath("/data/services/main-slots/slot-2");
const REPO = asAppPath("/repo");
const MAIN_SHA = "c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4";

interface Recorded {
  slotFor: string | null;
  slotOpts: unknown;
  spawned: { argv: string[]; cwd: AppPath; env: Record<string, unknown> }[];
}

/** The Build button's build: `./equin build --allow-main` run by main's backend, in the slot it serves from. */
function buttonDeps(exitCode: number): { deps: SlotRelayDeps; rec: Recorded } {
  const rec: Recorded = { slotFor: null, slotOpts: null, spawned: [] };
  const deps: SlotRelayDeps = {
    mainRepoRoot: async (root) => {
      expect(root).toBe(SERVED_SLOT);
      return REPO;
    },
    mainHead: async (repoRoot) => {
      expect(repoRoot).toBe(REPO);
      return MAIN_SHA;
    },
    runInBuildSlot: async (sha, opts, build) => {
      rec.slotFor = sha;
      rec.slotOpts = opts;
      return build({
        slot: FREE_SLOT,
        created: false,
        env: envEntries({ BUILD_SLOT: FREE_SLOT }),
      });
    },
    spawn: async (argv, opts) => {
      rec.spawned.push({ argv, cwd: opts.cwd, env: opts.env });
      return exitCode;
    },
    args: ["build", "--allow-main"],
    env: { PATH: "/bin", ...envEntries({ BUILD_ID: "build-1-abcdef" }) },
    log: () => {},
  };
  return { deps, rec };
}

describe("relayIntoSlot (the Build button's build on main)", () => {
  test("builds refs/heads/main in a slot handed to it, never in the slot it was started in", async () => {
    const { deps, rec } = buttonDeps(0);
    expect(await relayIntoSlot(SERVED_SLOT, deps)).toBe(0);

    // The commit main's convergence would build, prepared from the repo's store.
    expect(rec.slotFor).toBe(MAIN_SHA);
    expect(rec.slotOpts).toEqual({ repoRoot: REPO, label: "build-1-abcdef" });

    // One child build, run by the slot's own CLI, in the slot.
    expect(rec.spawned).toHaveLength(1);
    const [child] = rec.spawned;
    expect(child!.argv).toEqual([
      `${FREE_SLOT}/equin`,
      "build",
      "--allow-main",
    ]);
    expect(child!.cwd).toBe(FREE_SLOT);
    expect(child!.cwd).not.toBe(SERVED_SLOT);
  });

  test("the child keeps this run's environment (its BUILD_ID) and is told the slot is its own", async () => {
    const { deps, rec } = buttonDeps(0);
    await relayIntoSlot(SERVED_SLOT, deps);
    const env = rec.spawned[0]!.env;
    expect(env).toMatchObject(envEntries({ BUILD_ID: "build-1-abcdef" }));
    expect(env.PATH).toBe("/bin");
    expect(env).toMatchObject(envEntries({ BUILD_SLOT: FREE_SLOT }));
  });

  test("answers with the child's exit code", async () => {
    const { deps } = buttonDeps(3);
    expect(await relayIntoSlot(SERVED_SLOT, deps)).toBe(3);
  });

  test("a slot that cannot be prepared fails the relay, and no child is spawned", async () => {
    const { deps, rec } = buttonDeps(0);
    deps.runInBuildSlot = async () => {
      throw new Error("main-slots: the pool is at its cap");
    };
    expect(relayIntoSlot(SERVED_SLOT, deps)).rejects.toThrow(
      "the pool is at its cap",
    );
    expect(rec.spawned).toHaveLength(0);
  });
});
