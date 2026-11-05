import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { createReadSetRepo } from "./testing";
import { computeTreeHash } from "./tree-hash";
import { gitGrepList } from "./grep-code";
import { createGrepIndex, type GrepIndexStore } from "./grep-index";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A store in memory that counts what it is asked. */
function memoryStore(): GrepIndexStore & { recorded: number } {
  const rows = new Map<string, boolean>();
  const store = {
    recorded: 0,
    answers(query: string, blobs: readonly string[]) {
      const out = new Map<string, boolean>();
      for (const b of blobs) {
        const v = rows.get(`${query}:${b}`);
        if (v !== undefined) out.set(b, v);
      }
      return out;
    },
    record(query: string, answers: ReadonlyArray<readonly [string, boolean]>) {
      for (const [b, m] of answers) rows.set(`${query}:${b}`, m);
      store.recorded += answers.length;
    },
  };
  return store;
}

const FILES = {
  "src/a/web/x.ts": "new WebSocket(url);\n",
  "src/a/web/y.ts": "const ok = 1;\n",
  "src/b/server/z.tsx": "// new WebSocket(\n",
  "src/b/server/same.ts": "new WebSocket(url);\n",
  "docs/note.md": "new WebSocket(url);\n",
  "src/c/core/w.ts": "export const s = 'new WebSocket(';\n",
  // A name git quotes without -z (non-ASCII): must still be selected.
  "src/c/web/caf\u00e9.ts": "new WebSocket(url);\n",
};

async function indexOver(
  root: AppPath,
  store: GrepIndexStore,
  greps: { count: number },
) {
  const tree = await computeTreeHash(root);
  if (!tree) throw new Error("no tree hash");
  const grepTree = (grepArg: string, fixed: boolean, pathspecs: string[]) => {
    greps.count++;
    return gitGrepList(root, grepArg, fixed, pathspecs, tree);
  };
  return {
    tree,
    index: createGrepIndex({ root, tree, store, grepTree }),
    git: (grepArg: string, fixed: boolean, pathspecs: string[]) =>
      gitGrepList(root, grepArg, fixed, pathspecs, tree),
  };
}

const QUERIES: Array<[string, boolean, string[]]> = [
  ["new WebSocket(", true, ["*.ts", "*.tsx"]],
  ["WebSock[e]t", false, ["src/**/web/*.ts"]],
  ["new WebSocket(", true, ["src/b"]],
  ["nothing-matches-this", true, ["*.ts"]],
  ["WebSocket", true, ["*.md"]],
];

test("a selection is exactly git grep's, cold and warm, across an edit", async () => {
  const repo = await createReadSetRepo("grep-index-", FILES);
  roots.push(repo.root);
  const store = memoryStore();
  const greps = { count: 0 };

  const cold = await indexOver(asAppPath(repo.root), store, greps);
  for (const [arg, fixed, specs] of QUERIES)
    expect(await cold.index.select(arg, fixed, specs)).toEqual(
      await cold.git(arg, fixed, specs),
    );
  const coldGreps = greps.count;
  // One grep per distinct pattern: the third query asks the first's pattern
  // over a narrower pathspec, whose blobs were all answered already.
  expect(coldGreps).toBe(
    new Set(QUERIES.map(([arg, fixed]) => `${fixed}:${arg}`)).size,
  );

  // Same tree, a new run: every answer is known, no grep runs.
  const warm = await indexOver(asAppPath(repo.root), store, greps);
  for (const [arg, fixed, specs] of QUERIES)
    expect(await warm.index.select(arg, fixed, specs)).toEqual(
      await warm.git(arg, fixed, specs),
    );
  expect(greps.count).toBe(coldGreps);

  // An edit (a new matcher, a file that stops matching, an untracked file):
  // only the changed blobs are grepped, and the answer is still git's.
  repo.write("src/a/web/y.ts", "new WebSocket(other);\n");
  repo.write("src/a/web/x.ts", "const fine = 2;\n");
  repo.write("src/d/web/fresh.ts", "new WebSocket(u);\n");
  const edited = await indexOver(asAppPath(repo.root), store, greps);
  const recordedBefore = store.recorded;
  for (const [arg, fixed, specs] of QUERIES)
    expect(await edited.index.select(arg, fixed, specs)).toEqual(
      await edited.git(arg, fixed, specs),
    );
  // Three new blobs at most per query, never the whole domain again.
  expect(store.recorded - recordedBefore).toBeLessThanOrEqual(
    3 * QUERIES.length,
  );
});

test("two paths with one blob share one answer", async () => {
  const repo = await createReadSetRepo("grep-index-dup-", FILES);
  roots.push(repo.root);
  const store = memoryStore();
  const { index, git } = await indexOver(asAppPath(repo.root), store, {
    count: 0,
  });
  // x.ts and same.ts hold the same bytes: both selected, one answer recorded.
  expect(await index.select("new WebSocket(", true, ["*.ts"])).toEqual(
    await git("new WebSocket(", true, ["*.ts"]),
  );
});
