import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PrototypeHistorySchema,
  PrototypeVersionCountsSchema,
} from "../../core/history";
import {
  HISTORY_DIR_NAME,
  LATEST_STAMP_FILE,
  openHistoryStore,
  type HistoryStore,
} from "./store";

// The version store against a throwaway prototypes tree. The store takes its
// root as an argument, so nothing here touches `~/.singularity/apps/prototypes`.

const ID = "proto-1789000000-abcd";

let root: string;
let store: HistoryStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prototype-history-"));
  store = openHistoryStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeProto(files: Record<string, string | Uint8Array>) {
  const dir = join(root, ID);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
}

async function history() {
  const read = await store.readHistory(ID);
  if (read.kind !== "history") throw new Error(`no history: ${read.kind}`);
  // The loader's payload must satisfy the resource schema it is parsed against.
  return PrototypeHistorySchema.parse(read.history);
}

async function fileAt(sha: string, file: string): Promise<string> {
  const read = await store.readVersionFile(ID, sha, file);
  if (read.kind !== "found") throw new Error(`${file}@${sha} not found`);
  return new TextDecoder().decode(read.bytes);
}

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test (see the
 * host-semaphore suite's identical helper), so this asserts the rejection for
 * real.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

async function latestStamp(): Promise<unknown> {
  const path = join(root, HISTORY_DIR_NAME, `${ID}.git`, LATEST_STAMP_FILE);
  return JSON.parse(await readFile(path, "utf8"));
}

describe("ensureHistory", () => {
  test("records the folder as it is as a baseline v0", async () => {
    await writeProto({ "index.html": "<title>A</title>" });
    expect(await store.ensureHistory(ID)).toEqual({ kind: "created" });

    const { versions, dirty } = await history();
    expect(dirty).toBe(false);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      n: 0,
      kind: "baseline",
      subject: "Baseline",
      conversationId: null,
      messageId: null,
    });
    expect(versions[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await fileAt(versions[0]!.sha, "index.html")).toBe(
      "<title>A</title>",
    );
  });

  test("is idempotent, including under concurrent callers", async () => {
    await writeProto({ "index.html": "x" });
    const results = await Promise.all([
      store.ensureHistory(ID),
      store.ensureHistory(ID),
      store.ensureHistory(ID),
    ]);
    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
    expect((await history()).versions).toHaveLength(1);
    expect(await store.ensureHistory(ID)).toEqual({ kind: "exists" });
  });

  test("a missing folder is no-such-prototype; a bad id throws", async () => {
    expect(await store.ensureHistory(ID)).toEqual({
      kind: "no-such-prototype",
    });
    expect((await rejection(store.ensureHistory("../etc"))).message).toMatch(
      /not a prototype id/,
    );
  });

  test("writes the latest stamp for v0", async () => {
    await writeProto({ "index.html": "x" });
    await store.ensureHistory(ID);
    const { versions } = await history();
    expect(await latestStamp()).toEqual({ n: 0, sha: versions[0]!.sha });
  });

  test("adoptAll gives every minted-id folder a history, and skips the rest", async () => {
    await writeProto({ "index.html": "x" });
    await mkdir(join(root, "not-an-id"));
    await mkdir(join(root, "_template"));
    await store.adoptAll();
    expect((await history()).versions).toHaveLength(1);
    expect(existsSync(join(root, HISTORY_DIR_NAME, "not-an-id.git"))).toBe(
      false,
    );
    expect(existsSync(join(root, HISTORY_DIR_NAME, "_template.git"))).toBe(
      false,
    );
  });
});

describe("checkpoint", () => {
  test("records a change as a new version with its trailers", async () => {
    await writeProto({ "index.html": "v0" });
    await store.ensureHistory(ID);
    await writeProto({ "index.html": "v1" });

    const result = await store.checkpoint(ID, {
      kind: "turn",
      subject: "Make it blue\nand more lines",
      body: "Request:\n# a heading\n\nAgent summary:\ndone",
      conversationId: "conv-1",
      messageId: "msg-1",
    });
    expect(result.kind).toBe("recorded");
    if (result.kind !== "recorded") return;
    expect(result.version).toMatchObject({
      n: 1,
      kind: "turn",
      subject: "Make it blue",
      conversationId: "conv-1",
      messageId: "msg-1",
    });

    const read = await store.readHistory(ID);
    if (read.kind !== "history") throw new Error("no history");
    // `--cleanup=whitespace`: a markdown heading in the request survives.
    expect(read.entries[1]!.body).toBe(
      "Request:\n# a heading\n\nAgent summary:\ndone",
    );
    expect(await fileAt(result.version.sha, "index.html")).toBe("v1");
    expect(await latestStamp()).toEqual({ n: 1, sha: result.version.sha });
  });

  test("an unchanged folder records nothing", async () => {
    await writeProto({ "index.html": "v0" });
    await store.ensureHistory(ID);
    expect(
      await store.checkpoint(ID, { kind: "manual", subject: "again" }),
    ).toEqual({ kind: "unchanged" });
    expect((await history()).versions).toHaveLength(1);
  });

  test("a messageId already recorded is a no-op, even with new changes", async () => {
    await writeProto({ "index.html": "v0" });
    await store.ensureHistory(ID);
    await writeProto({ "index.html": "v1" });
    const turn = {
      kind: "turn",
      subject: "turn",
      messageId: "msg-dup",
    } as const;
    expect((await store.checkpoint(ID, turn)).kind).toBe("recorded");

    await writeProto({ "index.html": "v2" });
    expect(await store.checkpoint(ID, turn)).toEqual({ kind: "unchanged" });
    const { versions, dirty } = await history();
    expect(versions).toHaveLength(2);
    expect(dirty).toBe(true);
  });

  test("concurrent checkpoints of one turn record it once", async () => {
    await writeProto({ "index.html": "v0" });
    await store.ensureHistory(ID);
    await writeProto({ "index.html": "v1" });
    const turn = { kind: "turn", subject: "t", messageId: "m" } as const;
    const results = await Promise.all([
      store.checkpoint(ID, turn),
      store.checkpoint(ID, turn),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual([
      "recorded",
      "unchanged",
    ]);
  });

  test("a prototype without a history is adopted first", async () => {
    await writeProto({ "index.html": "v0" });
    expect(
      await store.checkpoint(ID, { kind: "manual", subject: "first" }),
    ).toEqual({ kind: "unchanged" });
    expect((await history()).versions.map((v) => v.kind)).toEqual(["baseline"]);
  });

  test("an empty subject falls back to a kind-specific one", async () => {
    await writeProto({ "index.html": "v0" });
    await store.ensureHistory(ID);
    await writeProto({ "index.html": "v1" });
    const result = await store.checkpoint(ID, { kind: "turn", subject: "  " });
    expect(result.kind === "recorded" && result.version.subject).toBe(
      "Agent turn",
    );
  });

  test("a missing folder is no-such-prototype", async () => {
    expect(
      await store.checkpoint(ID, { kind: "manual", subject: "x" }),
    ).toEqual({ kind: "no-such-prototype" });
  });
});

describe("version options", () => {
  const page = (palette: string, values: string) =>
    `<html data-palette="${palette}"><meta name="prototype-option" content="palette: ${values}"><title>A</title></html>`;

  test("each version carries the options its OWN page declares", async () => {
    await writeProto({ "index.html": page("violet", "violet | azure") });
    await store.ensureHistory(ID);
    // The live page drops `violet` and gains `amber`.
    await writeProto({ "index.html": page("amber", "amber | azure") });
    await store.checkpoint(ID, { kind: "manual", subject: "recolour" });

    const [v0, v1] = (await history()).versions;
    expect(v0!.options).toEqual([
      {
        kind: "choice",
        name: "palette",
        values: ["violet", "azure"],
        default: "violet",
        group: null,
      },
    ]);
    expect(v1!.options).toEqual([
      {
        kind: "choice",
        name: "palette",
        values: ["amber", "azure"],
        default: "amber",
        group: null,
      },
    ]);
  });

  test("a version with no index.html declares none", async () => {
    await writeProto({});
    await store.ensureHistory(ID);
    await writeProto({ "index.html": page("violet", "violet | azure") });
    await store.checkpoint(ID, { kind: "manual", subject: "first page" });

    const [v0, v1] = (await history()).versions;
    expect(v0!.options).toEqual([]);
    expect(v1!.options).toHaveLength(1);
  });

  test("a checkpoint's answer carries the options too", async () => {
    await writeProto({ "index.html": "<title>A</title>" });
    await store.ensureHistory(ID);
    await writeProto({ "index.html": page("violet", "violet | azure") });
    const result = await store.checkpoint(ID, { kind: "manual", subject: "x" });
    if (result.kind !== "recorded") throw new Error(result.kind);
    expect(result.version.options.map((o) => o.name)).toEqual(["palette"]);
  });
});

describe("dirty", () => {
  test("tracks edits, additions and deletions, but not dot-files", async () => {
    await writeProto({ "index.html": "v0", "styles.css": "a" });
    await store.ensureHistory(ID);
    expect((await history()).dirty).toBe(false);

    await writeProto({ ".DS_Store": "finder" });
    expect((await history()).dirty).toBe(false);

    await writeProto({ "data.js": "new" });
    expect((await history()).dirty).toBe(true);
    await store.checkpoint(ID, { kind: "manual", subject: "add" });
    expect((await history()).dirty).toBe(false);

    await rm(join(root, ID, "styles.css"));
    expect((await history()).dirty).toBe(true);
  });
});

describe("readVersionFile", () => {
  test("returns binary bytes exactly", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128,
    ]);
    await writeProto({ "index.html": "x", "photo.png": png });
    await store.ensureHistory(ID);
    const sha = (await history()).versions[0]!.sha;
    const read = await store.readVersionFile(ID, sha, "photo.png");
    expect(read.kind).toBe("found");
    if (read.kind === "found") expect([...read.bytes]).toEqual([...png]);
  });

  test("an unknown file or sha is not-found; a bad argument throws", async () => {
    await writeProto({ "index.html": "x" });
    await store.ensureHistory(ID);
    const sha = (await history()).versions[0]!.sha;
    expect(await store.readVersionFile(ID, sha, "nope.css")).toEqual({
      kind: "not-found",
    });
    expect(
      await store.readVersionFile(ID, "0".repeat(40), "index.html"),
    ).toEqual({ kind: "not-found" });
    expect(
      (await rejection(store.readVersionFile(ID, "HEAD", "index.html")))
        .message,
    ).toMatch(/not a commit sha/);
    expect(
      (await rejection(store.readVersionFile(ID, sha, "../x"))).message,
    ).toMatch(/not a file name/);
  });
});

describe("restoreVersion", () => {
  test("writes the old tree back — added files deleted, deleted files restored", async () => {
    await writeProto({ "index.html": "v0", "old.css": "old" });
    await store.ensureHistory(ID);
    const v0 = (await history()).versions[0]!;

    await rm(join(root, ID, "old.css"));
    await writeProto({ "index.html": "v1", "new.js": "new" });
    await store.checkpoint(ID, { kind: "manual", subject: "v1" });

    const result = await store.restoreVersion(ID, v0.sha);
    expect(result.kind).toBe("restored");
    if (result.kind !== "restored") return;
    expect(result.version).toMatchObject({
      n: 2,
      kind: "restore",
      subject: "Restored v0",
    });

    expect(await readFile(join(root, ID, "index.html"), "utf8")).toBe("v0");
    expect(await readFile(join(root, ID, "old.css"), "utf8")).toBe("old");
    expect(existsSync(join(root, ID, "new.js"))).toBe(false);
    const after = await history();
    expect(after.dirty).toBe(false);
    expect(await latestStamp()).toEqual({ n: 2, sha: result.version.sha });
  });

  test("unsaved changes are recorded as 'Before restore' first", async () => {
    await writeProto({ "index.html": "v0" });
    await store.ensureHistory(ID);
    const v0 = (await history()).versions[0]!;
    await writeProto({ "index.html": "unsaved" });

    await store.restoreVersion(ID, v0.sha);
    const { versions } = await history();
    expect(versions.map((v) => [v.kind, v.subject])).toEqual([
      ["baseline", "Baseline"],
      ["manual", "Before restore"],
      ["restore", "Restored v0"],
    ]);
    expect(await fileAt(versions[1]!.sha, "index.html")).toBe("unsaved");
    expect(await readFile(join(root, ID, "index.html"), "utf8")).toBe("v0");
  });

  test("leaves untracked dot-files alone", async () => {
    await writeProto({ "index.html": "v0" });
    await store.ensureHistory(ID);
    const v0 = (await history()).versions[0]!;
    await writeProto({ "index.html": "v1", ".DS_Store": "finder" });
    await store.checkpoint(ID, { kind: "manual", subject: "v1" });

    await store.restoreVersion(ID, v0.sha);
    expect(await readFile(join(root, ID, ".DS_Store"), "utf8")).toBe("finder");
  });

  test("an unknown sha is unknown-version; a missing folder is no-such-prototype", async () => {
    expect(await store.restoreVersion(ID, "a".repeat(40))).toEqual({
      kind: "no-such-prototype",
    });
    await writeProto({ "index.html": "v0" });
    await store.ensureHistory(ID);
    expect(await store.restoreVersion(ID, "a".repeat(40))).toEqual({
      kind: "unknown-version",
    });
  });
});

describe("readVersionPatch", () => {
  test("shows what a version changed, and the whole tree for v0", async () => {
    await writeProto({ "index.html": "one\n" });
    await store.ensureHistory(ID);
    await writeProto({ "index.html": "two\n" });
    const result = await store.checkpoint(ID, { kind: "manual", subject: "x" });
    if (result.kind !== "recorded") throw new Error("not recorded");
    const { versions } = await history();

    expect(await store.readVersionPatch(ID, versions[0]!.sha)).toContain(
      "+one",
    );
    const patch = await store.readVersionPatch(ID, result.version.sha);
    expect(patch).toContain("-one");
    expect(patch).toContain("+two");
  });
});

describe("readVersionCounts", () => {
  const stampPath = () =>
    join(root, HISTORY_DIR_NAME, `${ID}.git`, LATEST_STAMP_FILE);

  test("no history dir yet: no counts", async () => {
    expect(await store.readVersionCounts()).toEqual({});
  });

  test("counts every version, v0 included, and follows each new one", async () => {
    await writeProto({ "index.html": "one" });
    await store.ensureHistory(ID);
    expect(await store.readVersionCounts()).toEqual({ [ID]: 1 });

    await writeProto({ "index.html": "two" });
    await store.checkpoint(ID, { kind: "manual", subject: "x" });
    const counts = await store.readVersionCounts();
    expect(counts).toEqual({ [ID]: 2 });
    // The loader's payload must satisfy the resource schema.
    expect(PrototypeVersionCountsSchema.parse(counts)).toEqual(counts);
  });

  test("a repo without a stamp is absent, never 0", async () => {
    await writeProto({ "index.html": "one" });
    await store.ensureHistory(ID);
    await rm(stampPath());
    expect(await store.readVersionCounts()).toEqual({});
  });

  test("a malformed stamp throws, naming the file", async () => {
    await writeProto({ "index.html": "one" });
    await store.ensureHistory(ID);
    await writeFile(stampPath(), JSON.stringify({ n: "three" }));
    const err = await rejection(store.readVersionCounts());
    expect(err.message).toContain(stampPath());
  });

  test("ignores what is not a prototype's repo", async () => {
    await mkdir(join(root, HISTORY_DIR_NAME, "not-an-id.git"), {
      recursive: true,
    });
    await writeFile(join(root, HISTORY_DIR_NAME, `${ID}.lock`), "");
    expect(await store.readVersionCounts()).toEqual({});
  });
});
