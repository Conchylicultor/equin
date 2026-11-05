import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { holdTreeRead, treeLockPath, withTreeWrite } from "./tree-lock";

const base = mkdtempSync(join(tmpdir(), "tree-lock-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function mainCheckout(name: string) {
  const root = join(base, name);
  mkdirSync(join(root, ".git"), { recursive: true });
  return asAppPath(root);
}

describe("treeLockPath", () => {
  test("main checkout: inside its .git dir", () => {
    const root = mainCheckout("main");
    expect(treeLockPath(root)).toMatch(/\/main\/\.git\/[^/]+\/tree\.lock$/);
  });

  test("linked worktree: inside the gitdir its .git file names", () => {
    const root = join(base, "linked");
    mkdirSync(root);
    writeFileSync(
      join(root, ".git"),
      `gitdir: ${base}/main/.git/worktrees/linked\n`,
    );
    expect(treeLockPath(asAppPath(root))).toMatch(
      /\/main\/\.git\/worktrees\/linked\/[^/]+\/tree\.lock$/,
    );
  });

  test("not a checkout: null", () => {
    const root = join(base, "plain");
    mkdirSync(root);
    expect(treeLockPath(asAppPath(root))).toBeNull();
  });
});

describe("read / write exclusion", () => {
  test("a write waits for every reader, then runs", async () => {
    const root = mainCheckout("rw");
    const a = await holdTreeRead(root);
    const b = await holdTreeRead(root); // readers share
    const order: string[] = [];
    const writing = withTreeWrite(root, async () => {
      order.push("write");
    });
    await Bun.sleep(300);
    order.push("readers-release");
    a.releaseSync();
    b.releaseSync();
    await writing;
    expect(order).toEqual(["readers-release", "write"]);
  });

  test("a reader arriving during a write waits for it", async () => {
    const root = mainCheckout("wr");
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const inWrite = new Promise<void>((r) => (started = r));
    const writing = withTreeWrite(root, async () => {
      started();
      await gate;
      order.push("write-done");
    });
    await inWrite;
    const reading = holdTreeRead(root).then((held) => {
      order.push("read");
      return held;
    });
    await Bun.sleep(300);
    release();
    await writing;
    const held = await reading;
    await held.release();
    expect(order).toEqual(["write-done", "read"]);
  });
});
