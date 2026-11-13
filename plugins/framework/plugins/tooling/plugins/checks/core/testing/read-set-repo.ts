import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { computeTreeHash } from "../tree-hash";
import {
  loadTreeSnapshot,
  validate,
  type FileSystemView,
  type ReadSet,
  type TreeSnapshot,
  type ValidateResult,
} from "../read-set";
import type { CheckCodeKey } from "../check-code-key";

/**
 * The code key a fixture's read-sets are recorded and replayed under, unless a
 * test names another: these repos test the TREE side of a read-set, so the
 * code is held fixed. (`check-code-key.test.ts` tests the code side.)
 */
const FIXTURE_CODE_KEY = "fixture-code" as CheckCodeKey;

const GIT_TIMEOUT_MS = 30_000;

/**
 * A throwaway git repo a check's input-keyed read-set is recorded against and
 * revalidated against, the same way the check runner drives it: snapshot the
 * tree, record the check's reads under a recording view, then validate that
 * read-set against a FRESH snapshot once the test has changed the tree.
 */
export interface ReadSetRepo {
  readonly root: string;
  /** Write a repo-relative file (parents created), without committing it. */
  write(rel: string, content: string): void;
  /** Delete a repo-relative file or directory. */
  remove(rel: string): void;
  /** Run `recordReads` under a recording view of the current tree, by the code `codeKey` names. */
  record(
    recordReads: (view: FileSystemView) => void | Promise<void>,
    codeKey?: CheckCodeKey,
  ): Promise<ReadSet>;
  /** Validate `readSet` against a fresh snapshot of the current tree, for the code `codeKey` names. */
  revalidate(readSet: ReadSet, codeKey?: CheckCodeKey): Promise<ValidateResult>;
  /** A fresh snapshot of the current tree — what `ctx.snapshot()` hands a check. */
  snapshot(): Promise<TreeSnapshot>;
  /** Delete the repo. */
  dispose(): void;
}

/** Create the repo holding `files` (repo-relative path → content), committed. */
export async function createReadSetRepo(
  prefix: string,
  files: Readonly<Record<string, string>>,
): Promise<ReadSetRepo> {
  const root = asAppPath(mkdtempSync(join(tmpdir(), prefix)));
  const git = (...args: string[]) =>
    spawnExpectOk(["git", ...args], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const snapshot = async (): Promise<TreeSnapshot> => {
    const treeHash = await computeTreeHash(root);
    if (!treeHash) throw new Error(`computeTreeHash(${root}) returned no hash`);
    const snap = await loadTreeSnapshot(root, treeHash);
    if (!snap)
      throw new Error(
        `loadTreeSnapshot(${root}, ${treeHash}) returned no snapshot`,
      );
    return snap;
  };

  for (const [rel, content] of Object.entries(files)) write(rel, content);
  await git("init", "-q");
  await git("config", "user.email", "t@t.t");
  await git("config", "user.name", "t");
  await git("add", "-A");
  await git("commit", "-q", "-m", "fixture");

  return {
    root,
    write,
    remove: (rel) => rmSync(join(root, rel), { recursive: true, force: true }),
    async record(recordReads, codeKey = FIXTURE_CODE_KEY) {
      const view = (await snapshot()).createRecordingView(codeKey);
      await recordReads(view);
      return view.readSet();
    },
    async revalidate(readSet, codeKey = FIXTURE_CODE_KEY) {
      return validate(readSet, await snapshot(), codeKey);
    },
    snapshot,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
