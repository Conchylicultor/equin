/**
 * `openRepoView` against a throwaway git repo: a noted write (a file, a
 * removal, a whole directory) is what a fresh snapshot says, and a write the
 * view was not told about fails `assertAgrees` by name — only for what a
 * reader asked of it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { loadRepoSnapshot } from "./repo-files";
import { openRepoView } from "./repo-view";

let root!: AppPath;

function write(rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}

function git(...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd: root });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

beforeEach(() => {
  root = asAppPath(mkdtempSync(join(tmpdir(), "repo-view-")));
  git("init", "-q");
  write(".gitignore", "ignored/\n");
  write("a.ts", "a\n");
  write("gen/x.ts", "x\n");
  write("gen/y.ts", "y\n");
  git("add", "-A");
  git("-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "init");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a noted write, creation and removal read as a fresh snapshot does", async () => {
  const view = await openRepoView(root);
  const first = await view.current();
  expect(await view.current()).toBe(first);
  view.noteWrites([
    write("a.ts", "a2\n"),
    write("new.ts", "n\n"),
    write("ignored/z.ts", "z\n"),
  ]);
  unlinkSync(join(root, "gen/y.ts"));
  view.noteWrites([join(root, "gen/y.ts"), "/elsewhere/outside.ts"]);
  const now = await view.current();
  const fresh = await loadRepoSnapshot(root);
  expect(now.all()).toEqual(fresh.all());
  for (const p of fresh.all()) expect(now.blobOf(p)).toBe(fresh.blobOf(p));
  expect(now.has("ignored/z.ts")).toBe(false);
  await view.assertAgrees(fresh);
});

test("a noted directory is asked of git whole", async () => {
  const view = await openRepoView(root);
  write("gen/x.ts", "x2\n");
  write("gen/new.ts", "n\n");
  unlinkSync(join(root, "gen/y.ts"));
  view.noteWrites([join(root, "gen")]);
  const now = await view.current();
  expect(now.under("gen")).toEqual(["gen/new.ts", "gen/x.ts"]);
  await view.assertAgrees(await loadRepoSnapshot(root));
});

test("a write the view was not told about fails the check, naming the file — only once a reader asked", async () => {
  const view = await openRepoView(root);
  const snap = await view.current();
  write("gen/x.ts", "unnoted\n");
  // Nobody asked about gen/x.ts yet: nothing keyed by it.
  await view.assertAgrees(await loadRepoSnapshot(root));
  snap.blobOf("gen/x.ts");
  expect(view.assertAgrees(await loadRepoSnapshot(root))).rejects.toThrow(
    "gen/x.ts: content changed",
  );
});

test("a file appearing under a listed directory fails the check", async () => {
  const view = await openRepoView(root);
  (await view.current()).under("gen");
  write("gen/sneaky.ts", "s\n");
  expect(view.assertAgrees(await loadRepoSnapshot(root))).rejects.toThrow(
    "gen/: files added or removed",
  );
});

test("overlapping refreshes: a caller during a refresh still sees every write noted before it asked", async () => {
  const view = await openRepoView(root);
  view.noteWrites([write("a.ts", "a2\n")]);
  const first = view.current();
  view.noteWrites([write("new.ts", "n\n")]);
  const second = await view.current();
  await first;
  const fresh = await loadRepoSnapshot(root);
  expect(second.has("new.ts")).toBe(true);
  expect(second.blobOf("a.ts")).toBe(fresh.blobOf("a.ts"));
  expect(second.blobOf("new.ts")).toBe(fresh.blobOf("new.ts"));
});
