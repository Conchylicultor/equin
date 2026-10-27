import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskDirMount } from "@plugins/infra/plugins/paths/plugins/data-files/machine";
import { describeHistoryContract } from "../../../server/testing";
import {
  GIT_HISTORY_FORMAT,
  openGitHistoryStore,
  type GitHistoryStore,
} from "./store";

// The desktop's version store against a throwaway prototypes tree: the shared
// contract every provider passes, then what only git does. The store takes its
// directory as an argument, so nothing here touches
// `~/.equin/apps/prototypes`.

describeHistoryContract("git", async () => {
  const root = await mkdtemp(join(tmpdir(), "prototype-history-"));
  const files = diskDirMount(root);
  return {
    history: openGitHistoryStore({ dir: () => root, files }),
    files,
    format: GIT_HISTORY_FORMAT,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
});

const ID = "proto-1789000000-abcd";

let root: string;
let store: GitHistoryStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prototype-history-git-"));
  store = openGitHistoryStore({ dir: () => root, files: diskDirMount(root) });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeProto(files: Record<string, string>) {
  const dir = join(root, ID);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
}

describe("git history", () => {
  test("a version's sha is its commit's, and the repo sits at _history/<id>.git", async () => {
    await writeProto({ "index.html": "x" });
    await store.ensureHistory(ID);
    const read = await store.readHistory(ID);
    if (read.kind !== "history") throw new Error(read.kind);
    expect(read.history.versions[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(
      await Bun.file(join(root, "_history", `${ID}.git`, "HEAD")).exists(),
    ).toBe(true);
  });

  test("the per-repo lock is the _history/<id>.lock file every process takes", async () => {
    await writeProto({ "index.html": "x" });
    await store.ensureHistory(ID);
    expect(await Bun.file(join(root, "_history", `${ID}.lock`)).exists()).toBe(
      true,
    );
  });

  test("readVersionPatch shows what a version changed, and the whole tree for v0", async () => {
    await writeProto({ "index.html": "one\n" });
    await store.ensureHistory(ID);
    await writeProto({ "index.html": "two\n" });
    const result = await store.checkpoint(ID, { kind: "manual", subject: "x" });
    if (result.kind !== "recorded") throw new Error("not recorded");
    const read = await store.readHistory(ID);
    if (read.kind !== "history") throw new Error(read.kind);

    expect(
      await store.readVersionPatch(ID, read.history.versions[0]!.sha),
    ).toContain("+one");
    const patch = await store.readVersionPatch(ID, result.version.sha);
    expect(patch).toContain("-one");
    expect(patch).toContain("+two");
  });
});
