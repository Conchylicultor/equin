import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { HOME_DIR } from "@plugins/infra/plugins/paths/plugins/data-root-layout/core";
import {
  journalChangesSince,
  journalCursor,
  MAX_CURSOR_AGE_MS,
} from "./journal";

// The real FSEvents journal, so macOS only. Under the home dir: the journal is
// trusted on the user's data volume alone.
const onFsEvents = process.platform === "darwin";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(HOME_DIR, ".equin-journal-test-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function cursorOf(root: string) {
  const result = await journalCursor(root);
  if (result.kind !== "cursor") throw new Error(result.reason);
  return result.cursor;
}

test.if(onFsEvents)(
  "a replay names what changed since the cursor",
  async () => {
    await mkdir(join(dir, "sub"));
    const cursor = await cursorOf(dir);
    await writeFile(join(dir, "sub", "new.mid"), "x");

    const replay = await journalChangesSince(cursor);
    expect(replay.kind).toBe("changes");
    if (replay.kind === "changes")
      expect(replay.paths).toContain(join(dir, "sub", "new.mid"));
  },
);

test.if(onFsEvents)("a replay leaves out what the caller ignores", async () => {
  await mkdir(join(dir, "kept"));
  await mkdir(join(dir, "skipped", "deep"), { recursive: true });
  const cursor = await cursorOf(dir);
  await writeFile(join(dir, "kept", "a.ts"), "x");
  await writeFile(join(dir, "skipped", "deep", "b.ts"), "x");

  const replay = await journalChangesSince(cursor, {
    ignore: [join(dir, "skipped")],
  });
  expect(replay.kind).toBe("changes");
  if (replay.kind !== "changes") return;
  expect(replay.paths).toContain(join(dir, "kept", "a.ts"));
  expect(
    replay.paths.filter((p) => p.startsWith(join(dir, "skipped"))),
  ).toEqual([]);
});

test.if(onFsEvents)(
  "a folder replaced at its path cannot be vouched for",
  async () => {
    const root = join(dir, "root");
    await mkdir(root);
    const cursor = await cursorOf(root);
    await rm(root, { recursive: true });
    await mkdir(root);

    expect(await journalChangesSince(cursor)).toEqual({
      kind: "unknown",
      reason: `${root} was replaced`,
    });
  },
);

test("a folder off the user's data volume has no journal", async () => {
  // `/dev` is devfs, never the data volume (and not FSEvents elsewhere).
  expect((await journalCursor("/dev")).kind).toBe("unsupported");
});

test.if(onFsEvents)(
  "an old cursor, or a symlinked root, is not trusted",
  async () => {
    const cursor = await cursorOf(dir);
    expect(
      (
        await journalChangesSince({
          ...cursor,
          takenAt: Date.now() - MAX_CURSOR_AGE_MS - 1,
        })
      ).kind,
    ).toBe("unknown");

    const link = join(dir, "link");
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), link);
    expect((await journalCursor(link)).kind).toBe("unsupported");
  },
);

/** Run git in `cwd`, failing the test on a non-zero exit. */
async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(
    ["git", "-c", "user.name=test", "-c", "user.email=test@localhost", ...args],
    { cwd, stdout: "ignore", stderr: "pipe" },
  );
  const [code, err] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

// git rewrites a file as unlink + create, which FSEvents' history coalesces
// so that parcel's event list saw it created and deleted — and dropped it,
// although it is there with new content (upstream's addon: 247 of these 1,000
// unnamed; the patched one reports it as an update — parcel-addon's
// CLAUDE.md). A few hundred files did not reproduce it; this many do.
test.if(onFsEvents)(
  "a replay names every file a git checkout rewrote",
  async () => {
    const repo = join(dir, "repo");
    await mkdir(repo);
    await git(repo, ["init", "-q"]);
    const files = Array.from({ length: 2000 }, (_, i) => `d${i % 50}/f${i}.ts`);
    for (let d = 0; d < 50; d++) await mkdir(join(repo, `d${d}`));
    for (const f of files) await writeFile(join(repo, f), `1 ${f}\n`);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "one"]);
    const rewritten = files.filter((_, i) => i % 2 === 0);
    for (const f of rewritten) await writeFile(join(repo, f), `2 ${f}\n`);
    await git(repo, ["commit", "-q", "-am", "two"]);
    const cursor = await cursorOf(repo);
    await git(repo, ["checkout", "-q", "--detach", "HEAD~1"]);

    const replay = await journalChangesSince(cursor);
    expect(replay.kind).toBe("changes");
    if (replay.kind !== "changes") return;
    const named = new Set(replay.paths);
    expect(rewritten.filter((f) => !named.has(join(repo, f)))).toEqual([]);
  },
  120_000,
);
