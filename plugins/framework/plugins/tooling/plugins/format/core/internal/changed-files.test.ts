import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { listChangedFormattableFiles } from "./changed-files";

const tmp = mkdtempSync(join(tmpdir(), "changed-files-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.t",
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  await spawnExpectOk(["git", ...args], { cwd, timeoutMs: 60_000, env: ENV });
}

async function commit(
  cwd: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [file, body] of Object.entries(files))
    writeFileSync(join(cwd, file), body);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-q", "-m", Object.keys(files).join(" "));
}

test("an upstream release's own bytes are not the branch's change; what the branch did to them is", async () => {
  const repo = join(tmp, "repo");
  await git(tmp, "init", "-q", "-b", "main", repo);
  await commit(repo, {
    "kept.ts": "export const kept = 1;\n",
    "edited.ts": "export const a = 1;\nexport const b = 2;\n",
  });

  // Upstream's release: a new file and an edit, on a line of history of its
  // own, fetched into its release namespace.
  await git(repo, "checkout", "-q", "-b", "upstream");
  await commit(repo, {
    "upstream-new.ts": "export const fromUpstream = 1;\n",
    "edited.ts": "export const a = 10;\nexport const b = 2;\n",
  });
  await git(repo, "tag", "-a", "v2026.11.14", "-m", "release");
  await git(
    repo,
    "update-ref",
    "refs/release-tags/upstream/v2026.11.14",
    "refs/tags/v2026.11.14",
  );

  // The update branch merges the release, then touches one of its files.
  await git(repo, "checkout", "-q", "main");
  await git(repo, "checkout", "-q", "-b", "update");
  await git(repo, "merge", "-q", "--no-edit", "v2026.11.14^{commit}");
  await commit(repo, {
    "edited.ts": "export const a = 10;\nexport const b = 20;\n",
    "mine.ts": "export const mine = 1;\n",
  });

  const changed = await listChangedFormattableFiles(asAppPath(repo));
  expect(changed.map((c) => c.file)).toEqual(["edited.ts", "mine.ts"]);
  const edited = changed.find((c) => c.file === "edited.ts")!;
  // Scoped to the lines that differ from the RELEASE's bytes (only `b`), not
  // from the old main's (which would hand the branch upstream's `a` too).
  expect(edited.scope).toEqual({
    kind: "lines",
    base: "export const a = 10;\nexport const b = 2;\n",
  });
  expect(changed.find((c) => c.file === "mine.ts")!.scope).toEqual({
    kind: "file",
  });
});
