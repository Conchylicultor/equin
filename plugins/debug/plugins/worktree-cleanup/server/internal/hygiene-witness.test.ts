import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readEnv,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import { sweepHygiene } from "./hygiene-witness";

// A real repo with a linked worktree, and a data root of the test's own (the
// witness lives in the checkout's namespace dir under it).
const root = mkdtempSync(join(tmpdir(), "hygiene-witness-"));
const repo = join(root, "repo");
const wt = join(root, "att-1793716446-9gpf56");
const ns = asNamespace("att-1793716446-9gpf56");
const previousDir = readEnv("DIR");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" });

beforeAll(() => {
  setEnv("DIR", join(root, "data"));
  execFileSync("mkdir", ["-p", repo]);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "tracked.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "worktree", "add", "-q", "-b", "wt", wt);
});

afterAll(() => {
  if (previousDir === undefined) unsetEnv("DIR");
  else setEnv("DIR", previousDir);
  rmSync(root, { recursive: true, force: true });
});

describe("sweepHygiene — a dirty verdict is re-walked only on a real change", () => {
  test("first sweep walks; an untouched dirty tree is then witnessed", async () => {
    writeFileSync(join(wt, "notes.md"), "plan\n");
    const first = await sweepHygiene(ns, wt);
    expect(first).toEqual({
      hygiene: expect.objectContaining({ isDirty: true }),
      probed: true,
    });
    expect(existsSync(worktreeArtifacts.hygieneWitness(ns))).toBe(true);

    expect(await sweepHygiene(ns, wt)).toEqual({
      hygiene: { isDirty: true },
      probed: false,
    });
  });

  test("the witnessed path moving forces a walk", async () => {
    utimesSync(join(wt, "notes.md"), new Date(), new Date(Date.now() + 5000));
    expect((await sweepHygiene(ns, wt)).probed).toBe(true);
  });

  test("a commit (index + HEAD move) forces a walk", async () => {
    writeFileSync(join(wt, "tracked.txt"), "b\n");
    await sweepHygiene(ns, wt); // witness now names notes.md or tracked.txt
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "work");
    const after = await sweepHygiene(ns, wt);
    expect(after).toEqual({ hygiene: { isDirty: false }, probed: true });
    // Clean is never witnessed: the next sweep walks again.
    expect(existsSync(worktreeArtifacts.hygieneWitness(ns))).toBe(false);
  });

  test("the dirty file going away is seen, and reads clean", async () => {
    writeFileSync(join(wt, "scratch.md"), "x\n");
    expect((await sweepHygiene(ns, wt)).hygiene.isDirty).toBe(true);
    unlinkSync(join(wt, "scratch.md"));
    expect(await sweepHygiene(ns, wt)).toEqual({
      hygiene: { isDirty: false },
      probed: true,
    });
  });

  test("an unreadable witness proves nothing: walk again, never crash", async () => {
    writeFileSync(join(wt, "scratch.md"), "x\n");
    await sweepHygiene(ns, wt);
    writeFileSync(worktreeArtifacts.hygieneWitness(ns), '{"path": "scr');
    expect(await sweepHygiene(ns, wt)).toEqual({
      hygiene: expect.objectContaining({ isDirty: true }),
      probed: true,
    });
  });
});
