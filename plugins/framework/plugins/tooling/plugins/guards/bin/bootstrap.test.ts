import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as BOOT_LEASE from "@plugins/infra/plugins/git/plugins/main-slots/plugins/boot-lease/core";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { flockTry } from "@plugins/packages/plugins/flock/core";
import { openOwnedFdSync } from "@plugins/packages/plugins/owned-fd/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { STAMP_REL } from "@plugins/framework/plugins/cli/plugins/bootstrap/cli";
import {
  adminDirOf,
  assertCheckoutInstalled,
  CheckoutNotInstalledError,
  GIT_LOCK_DIR,
  holdGuardLease,
  noteGuardDrain,
  MAIN_SLOT_SERVED_FILE,
  MAIN_SLOT_STAMP,
  servedMainRoot,
  SLOT_DRAIN_LOG_DIR,
  SLOT_LEASES_DIR,
  SLOT_LOCK_FILE,
  SLOT_UNSERVED_FILE,
  INSTALL_STAMP_REL,
  runGuardWithFallback,
  withNotice,
  type Fallback,
} from "./bootstrap";

const DENY = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "no",
  },
});

function fallback(run: Fallback["run"]): () => Promise<Fallback> {
  return async () => ({ liveRoot: "/wt", mainRoot: "/main", run });
}

const broken = async (): Promise<string> => {
  throw new SyntaxError("Export named 'RESERVED_VIEW_PARAM' not found");
};

describe("runGuardWithFallback", () => {
  test("a live guard that runs is the verdict, main never asked", async () => {
    let asked = false;
    const result = await runGuardWithFallback({
      live: async () => DENY,
      fallback: async () => {
        asked = true;
        return null;
      },
    });
    expect(result).toEqual({ ok: true, stdout: DENY });
    expect(asked).toBe(false);
  });

  test("a live guard that throws gets main's verdict, with the error on it", async () => {
    const result = await runGuardWithFallback({
      live: broken,
      fallback: fallback(async () => ({ ok: true, stdout: DENY })),
    });
    if (!result.ok) throw new Error(result.stderr);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toStartWith(
      "no\n\n",
    );
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
      "RESERVED_VIEW_PARAM",
    );
  });

  test("main's silent allow still carries the notice", async () => {
    const result = await runGuardWithFallback({
      live: broken,
      fallback: fallback(async () => ({ ok: true, stdout: "" })),
    });
    if (!result.ok) throw new Error(result.stderr);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "main's guards (/main) judged this call",
    );
  });

  test("never fails open: no fallback, or a failing one, is a failure", async () => {
    const none = await runGuardWithFallback({
      live: broken,
      fallback: async () => null,
    });
    expect(none.ok).toBe(false);
    const failing = await runGuardWithFallback({
      live: broken,
      fallback: fallback(async () => ({ ok: false, error: "exit 1" })),
    });
    expect(failing.ok).toBe(false);
    if (!failing.ok) {
      expect(failing.stderr).toContain("RESERVED_VIEW_PARAM");
      expect(failing.stderr).toContain("exit 1");
    }
  });

  test("main's output that is not a hook output object is a failure, not an allow", async () => {
    const result = await runGuardWithFallback({
      live: broken,
      fallback: fallback(async () => ({ ok: true, stdout: "[]" })),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stderr).toContain("not a hook output object");
  });
});

describe("withNotice", () => {
  test("appends to an existing additional context, keeping a rewrite", () => {
    const out = JSON.parse(
      withNotice(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput: { command: "x" },
            additionalContext: "fact",
          },
        }),
        "note",
      ),
    );
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      updatedInput: { command: "x" },
      additionalContext: "fact\n\nnote",
    });
  });
});

describe("assertCheckoutInstalled", () => {
  let base = "";
  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  // A checkout with a `.git` file (a linked worktree) and the guard's own path.
  function checkout(): { root: string; script: string } {
    base = realpathSync(mkdtempSync(join(tmpdir(), "guard-install-")));
    const root = join(base, "wt");
    const bin = join(root, "plugins", "guards", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: /nowhere\n");
    return { root, script: join(bin, "guard.ts") };
  }

  test("the stamp it looks for is the one ensureDeps writes", () => {
    expect(INSTALL_STAMP_REL).toBe(STAMP_REL);
  });

  test("no stamp is a named failure, so main's guard runs with the reason", async () => {
    const { root, script } = checkout();
    expect(() => assertCheckoutInstalled(script)).toThrow(
      CheckoutNotInstalledError,
    );
    const result = await runGuardWithFallback({
      live: async () => {
        assertCheckoutInstalled(script);
        return DENY;
      },
      fallback: fallback(async () => ({ ok: true, stdout: "" })),
    });
    if (!result.ok) throw new Error(result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext as string;
    expect(context).toContain(
      `this checkout is not installed (no ${STAMP_REL} in ${root})`,
    );
    expect(context).not.toContain("at assertCheckoutInstalled");
  });

  test("a stamped checkout passes", () => {
    const { root, script } = checkout();
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, STAMP_REL), "{}");
    expect(() => assertCheckoutInstalled(script)).not.toThrow();
  });
});

describe("the main-slot lease", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    const r = spawnSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
      {
        cwd,
        encoding: "utf8",
      },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }

  /** A repo and a linked worktree of it, the worktree stamped a main slot. */
  function repoWithSlot(): { repo: string; slot: string; script: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-slot-")));
    dirs.push(base);
    const repo = join(base, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "a");
    const slot = join(base, "slot-1");
    git(repo, "worktree", "add", "-q", "--detach", slot);
    const admin = adminDirOf(slot)!;
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, MAIN_SLOT_STAMP), "{}\n");
    const script = join(slot, "bin", "guard.ts");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, "");
    return { repo, slot, script };
  }

  /** Whether a build could take the slot now (a non-blocking exclusive flock). */
  function buildCouldTake(slot: string): boolean {
    const fd = openOwnedFdSync(
      asAppPath(join(adminDirOf(slot)!, SLOT_LOCK_FILE)),
      "a",
    );
    try {
      return flockTry(fd.fd);
    } finally {
      fd.close();
    }
  }

  test("its copies of the slot layout are main-slots' own", () => {
    expect(GIT_LOCK_DIR).toBe(LEGACY_IDS.gitLockDir);
    expect(SLOT_LOCK_FILE).toBe(BOOT_LEASE.SLOT_LOCK_FILE);
    expect(SLOT_LEASES_DIR).toBe(BOOT_LEASE.SLOT_LEASES_DIR);
    expect(MAIN_SLOT_STAMP).toBe(BOOT_LEASE.MAIN_SLOT_STAMP);
    expect(MAIN_SLOT_SERVED_FILE).toBe(BOOT_LEASE.MAIN_SLOT_SERVED_FILE);
    expect(SLOT_UNSERVED_FILE).toBe(BOOT_LEASE.SLOT_UNSERVED_FILE);
    expect(SLOT_DRAIN_LOG_DIR).toBe(BOOT_LEASE.SLOT_DRAIN_LOG_DIR);
  });

  test("a guard released past its slot's switch leaves a drain record main-slots reads", () => {
    const { slot, script } = repoWithSlot();
    const admin = adminDirOf(slot)!;
    const lease = holdGuardLease(script);
    // Its app switched away a minute ago; the threshold is 10 s.
    writeFileSync(
      join(admin, SLOT_UNSERVED_FILE),
      BOOT_LEASE.renderUnserved({
        at: new Date(Date.now() - 60_000).toISOString(),
        reportAfterMs: 10_000,
      }),
    );
    lease.release();
    const dir = join(admin, SLOT_DRAIN_LOG_DIR);
    const names = readdirSync(dir);
    expect(names.length).toBe(1);
    const record = BOOT_LEASE.parseDrainRecord(
      names[0]!,
      readFileSync(join(dir, names[0]!), "utf8"),
    );
    expect([record.kind, record.label, record.pid, record.slot]).toEqual([
      "guard",
      null,
      process.pid,
      slot,
    ]);
    expect(record.heldPastSwitchMs).toBeGreaterThan(10_000);
    // Within the threshold, nothing.
    expect(noteGuardDrain(admin, slot, new Date(Date.now() - 55_000))).toBe(
      false,
    );
  });

  test("a guard in a slot holds it while it runs, recorded; outside one it holds nothing", () => {
    const { repo, slot, script } = repoWithSlot();
    const repoScript = join(repo, "guard.ts");
    writeFileSync(repoScript, "");
    expect(holdGuardLease(repoScript).slot).toBeNull();

    const lease = holdGuardLease(script);
    expect(lease.slot).toBe(slot);
    expect(buildCouldTake(slot)).toBe(false);
    const records = readdirSync(join(adminDirOf(slot)!, SLOT_LEASES_DIR));
    expect(records).toEqual([`${process.pid}.g1.json`]);
    const record = BOOT_LEASE.parseHolder(
      records[0]!,
      readFileSync(
        join(adminDirOf(slot)!, SLOT_LEASES_DIR, records[0]!),
        "utf8",
      ),
    );
    expect([record.kind, record.mode]).toEqual(["guard", "shared"]);
    lease.release();
    expect(readdirSync(join(adminDirOf(slot)!, SLOT_LEASES_DIR))).toEqual([]);
    expect(buildCouldTake(slot)).toBe(true);
  });

  test("main's served root is the slot most recently served, else the repo's checkout", () => {
    const { repo, slot } = repoWithSlot();
    const commonDir = join(repo, ".git");
    expect(servedMainRoot(commonDir, repo)).toBe(repo);
    writeFileSync(
      join(adminDirOf(slot)!, MAIN_SLOT_SERVED_FILE),
      "2026-11-17T00:00:00.000Z\n",
    );
    expect(realpathSync(servedMainRoot(commonDir, repo))).toBe(slot);
  });
});
