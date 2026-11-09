/**
 * `computeTreeHash` against a throwaway git repo. Pins the two halves of its
 * contract: the hash is the working tree's (a racily clean edit — same size,
 * same mtime second as the index — is still caught), and what its refresh
 * learns is published to the real index without changing what it stages, so
 * the next run has nothing left to re-read — unless a writer holds the lock.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  computeTreeHash,
  excludeAsPositive,
  listTreePathspec,
} from "./tree-hash";

let root!: AppPath;
let index!: string;

async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0)
    throw new Error(`git ${args.join(" ")} failed`);
  return out.trim();
}

/** Entries git must re-check by content: mtime second ≥ the index's own. */
async function racyCount(): Promise<number> {
  const indexSec = Math.floor(statSync(index).mtimeMs / 1000);
  return (await git("ls-files", "--debug"))
    .split("\n")
    .filter((l) => l.startsWith("  mtime:"))
    .filter((l) => Number(l.slice(9).split(":")[0]) >= indexSec).length;
}

/** Stamp a file with the index's mtime: written in the index's last second. */
function makeRacy(rel: string): void {
  const t = statSync(index).mtime;
  utimesSync(join(root, rel), t, t);
}

/** What `add -A` + `write-tree` gives in a scratch copy — the reference hash. */
async function referenceHash(): Promise<string> {
  const scratch = join(root, "..", "ref-index");
  rmSync(scratch, { force: true });
  const run = async (...args: string[]): Promise<string> => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      env: { ...process.env, GIT_INDEX_FILE: scratch },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  };
  await run("add", "-A");
  return run("write-tree");
}

beforeEach(async () => {
  root = asAppPath(mkdtempSync(join(tmpdir(), "tree-hash-test-")));
  root = asAppPath(join(root, "repo"));
  await Bun.write(join(root, ".keep"), "");
  await git("init", "-q", "-b", "main");
  for (const name of ["a.txt", "b.txt", "c.txt"])
    writeFileSync(join(root, name), `${name} v1\n`);
  await git("add", "-A");
  await git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  );
  index = join(root, ".git", "index");
});

afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("computeTreeHash", () => {
  test("a racily clean edit (same size, the index's mtime second) is hashed", async () => {
    const clean = await computeTreeHash(root);
    writeFileSync(join(root, "a.txt"), "a.txt v2\n"); // same size as v1
    makeRacy("a.txt");
    const edited = await computeTreeHash(root);
    expect(edited).not.toBe(clean);
    expect(edited).toBe(await referenceHash());
    // And again, after the first run published its refresh.
    expect(await computeTreeHash(root)).toBe(edited);
  });

  test("publishes the refresh: the next run has no racy entry left", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) makeRacy(name);
    expect(await racyCount()).toBeGreaterThanOrEqual(3);
    await Bun.sleep(1100); // the published index is written in a later second
    const hash = await computeTreeHash(root);
    expect(hash).toBe(await referenceHash());
    expect(await racyCount()).toBe(0);
    expect(existsSync(`${index}.lock`)).toBe(false);
    // Settled: a run with nothing to learn leaves the index alone (no rewrite
    // for the checkout watchers to hear), even with a modified file.
    writeFileSync(join(root, "b.txt"), "b.txt v2 longer\n");
    await computeTreeHash(root);
    const settled = statSync(index).mtimeMs;
    await Bun.sleep(1100);
    expect(await computeTreeHash(root)).toBe(await referenceHash());
    expect(statSync(index).mtimeMs).toBe(settled);
  });

  test("never changes what the real index stages", async () => {
    writeFileSync(join(root, "b.txt"), "b staged\n");
    await git("add", "b.txt");
    writeFileSync(join(root, "b.txt"), "b worktree\n");
    writeFileSync(join(root, "new.txt"), "untracked\n");
    makeRacy("c.txt");
    const staged = await git("diff", "--cached", "--name-status");
    const tracked = await git("ls-files");
    await Bun.sleep(1100);
    expect(await computeTreeHash(root)).toBe(await referenceHash());
    expect(await git("diff", "--cached", "--name-status")).toBe(staged);
    expect(await git("ls-files")).toBe(tracked);
    expect(await git("show", ":b.txt")).toBe("b staged");
  });

  test("a linked worktree seeds from, and publishes to, its own index", async () => {
    // `--git-path index` answers absolute in a linked worktree; joined onto
    // the root it named no file, so the hash ran on an empty index (the whole
    // tree re-hashed every run) and nothing could be published.
    const main = root;
    const linked = asAppPath(join(main, "..", "linked"));
    await git("worktree", "add", "-q", "--detach", linked);
    root = linked;
    index = await git(
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    );
    makeRacy("a.txt");
    expect(await racyCount()).toBeGreaterThanOrEqual(1);
    await Bun.sleep(1100);
    expect(await computeTreeHash(linked)).toBe(await referenceHash());
    expect(await racyCount()).toBe(0);
    root = main;
  });

  test("sweeps the scratch indexes of dead runs, never a live one's", async () => {
    const dead = `${index}.equin-tree-hash-99999999-deadbeef`;
    const live = `${index}.equin-refreshed-${process.pid}-cafe0001`;
    writeFileSync(dead, "debris");
    writeFileSync(live, "in use");
    expect(await computeTreeHash(root)).toBe(await referenceHash());
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  test("a held index.lock is left alone and nothing is published", async () => {
    makeRacy("a.txt");
    writeFileSync(`${index}.lock`, "held by a writer");
    const before = readFileSync(index);
    await Bun.sleep(1100);
    expect(await computeTreeHash(root)).toBe(await referenceHash());
    expect(readFileSync(index).equals(before)).toBe(true);
    expect(readFileSync(`${index}.lock`, "utf8")).toBe("held by a writer");
  });

  test("equals a plain `add -A` through every kind of change", async () => {
    // Each step's hash is compared with a fresh index's `add -A`: the scoped
    // add (only the paths status names) must write the same tree.
    const steps: Array<[string, () => Promise<void> | void]> = [
      ["nothing changed", () => {}],
      ["an edit", () => writeFileSync(join(root, "a.txt"), "a edited\n")],
      ["a new file", () => writeFileSync(join(root, "new.txt"), "new\n")],
      [
        "a new nested directory",
        () => {
          mkdirSync(join(root, "d/e/f"), { recursive: true });
          writeFileSync(join(root, "d/e/f/deep.txt"), "deep\n");
          writeFileSync(join(root, "d/top.txt"), "top\n");
        },
      ],
      ["a deletion", () => rmSync(join(root, "b.txt"))],
      [
        "a tracked file replaced by a directory",
        () => {
          rmSync(join(root, "c.txt"));
          mkdirSync(join(root, "c.txt"));
          writeFileSync(join(root, "c.txt/inside.txt"), "inside\n");
        },
      ],
      [
        "an ignored file, then the .gitignore edited",
        () => {
          writeFileSync(join(root, ".gitignore"), "*.log\n");
          writeFileSync(join(root, "x.log"), "ignored\n");
        },
      ],
      [
        ".gitignore no longer ignores it",
        () => writeFileSync(join(root, ".gitignore"), "\n"),
      ],
      [
        "a name needing quoting",
        () => writeFileSync(join(root, 'sp ace "q" é*.txt'), "odd\n"),
      ],
      [
        "a nested repository (gitlink)",
        async () => {
          mkdirSync(join(root, "nested"));
          writeFileSync(join(root, "nested/n.txt"), "n\n");
          const proc = Bun.spawn(
            [
              "sh",
              "-c",
              "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm n",
            ],
            { cwd: join(root, "nested") },
          );
          await proc.exited;
        },
      ],
      [
        "the new directory removed",
        () => rmSync(join(root, "d"), { recursive: true }),
      ],
    ];
    for (const [name, step] of steps) {
      await step();
      const hash = await computeTreeHash(root);
      expect({ name, hash }).toEqual({ name, hash: await referenceHash() });
    }
  });

  test("publishes git's untracked cache to the real index", async () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub/u.txt"), "u\n");
    await Bun.sleep(1100);
    await computeTreeHash(root);
    // The real index now carries an untracked cache another reader can use.
    const proc = Bun.spawn(
      ["git", "-c", "core.untrackedCache=true", "status", "--porcelain"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_TRACE2_PERF: "1", GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    const trace = await new Response(proc.stderr).text();
    await proc.exited;
    // Every directory is still stat'ed; without a cache each is also opened
    // and read (`.`, `sub`). With it, none.
    const opened = /opendir:(\d+)/.exec(trace);
    expect(opened).not.toBeNull();
    expect(Number(opened![1])).toBe(0);
  });
});

describe("listTreePathspec", () => {
  // What `git grep <tree> -- <pathspecs>` searches. `ls-files` given the same
  // pathspecs keeps a leading-`**` exclude's files when the positives share a
  // leading directory of 2+ characters (`src/`, not `p/`) — the grep index then re-grepped a new test file by its literal
  // path and counted it (a fixture pane in `pane:identity-manifest`).
  test("drops what a leading-** exclude names beside prefixed positives", async () => {
    for (const rel of [
      "src/x/a.ts",
      "src/x/__tests__/b.ts",
      "src/y/c.test.ts",
    ]) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), "defineRoute\n");
    }
    await git("add", "-A");
    const tree = await git("write-tree");
    const listed = await listTreePathspec(root, tree, [
      "src/**/*.ts",
      ":(exclude)**/__tests__/**",
      ":(exclude)**/*.test.ts",
    ]);
    expect(listed.map((e) => e.path)).toEqual(["src/x/a.ts"]);
    const grepped = (
      await git(
        "grep",
        "-l",
        "defineRoute",
        tree,
        "--",
        "src/**/*.ts",
        ":(exclude)**/__tests__/**",
        ":(exclude)**/*.test.ts",
      )
    )
      .split("\n")
      .map((l) => l.slice(tree.length + 1));
    expect(grepped).toEqual(["src/x/a.ts"]);
  });
});

describe("excludeAsPositive", () => {
  test("turns every exclude spelling into the positive it names", () => {
    expect(excludeAsPositive(":(exclude)**/x")).toBe("**/x");
    expect(excludeAsPositive(":(exclude,glob)**/x")).toBe(":(glob)**/x");
    expect(excludeAsPositive(":!x")).toBe("x");
    expect(excludeAsPositive(":^x")).toBe("x");
    expect(excludeAsPositive(":!/x")).toBe(":/x");
  });

  test("leaves a positive alone", () => {
    expect(excludeAsPositive("p/**/*.ts")).toBeNull();
    expect(excludeAsPositive(":(glob)p/**")).toBeNull();
    expect(excludeAsPositive(":(literal)p/a.ts")).toBeNull();
  });
});
