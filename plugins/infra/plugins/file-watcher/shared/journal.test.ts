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
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
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
