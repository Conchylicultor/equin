// The prototype version store's contract as one suite, run against every
// provider — the desktop's git repos and a browser host's snapshots — so the
// two cannot drift apart. A provider's own test file calls
// `describeHistoryContract` with a harness that hands out a fresh, empty tree
// and a history over it per test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  readText,
  relPath,
  type Mount,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
// Own-plugin test code: the internal files, never the public barrel.
import {
  PrototypeHistorySchema,
  PrototypeVersionCountsSchema,
} from "../../core/history";
import {
  HISTORY_DIR_NAME,
  historyStampOf,
  isVersionSha,
  type HistoryStore,
} from "../internal/history-store";

export interface HistoryHarness {
  /** The provider under test, over {@link files}. */
  history: HistoryStore;
  /** The prototypes tree it keeps the history of — empty. */
  files: Mount;
  /** Its history dirs' suffix: `_history/<id>.<format>`. */
  format: string;
  /** Tear down whatever the harness made (a temp dir). */
  dispose(): Promise<void>;
}

const ID = "proto-1789000000-abcd";
const writer = systemOrigin("history contract");
const w = { writer };

/** Await `p` and return the Error it rejected with; throw if it resolved. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/**
 * The `HistoryStore` contract, against the provider `make` builds. `name`
 * labels the suite (`"git"`, `"snapshots"`).
 */
export function describeHistoryContract(
  name: string,
  make: () => Promise<HistoryHarness>,
): void {
  describe(`HistoryStore contract — ${name}`, () => {
    let h: HistoryHarness;
    let store: HistoryStore;

    beforeEach(async () => {
      h = await make();
      store = h.history;
    });
    afterEach(async () => {
      await h.dispose();
    });

    /** Write files into the prototype's folder (a `.keep` makes an empty one). */
    async function writeProto(files: Record<string, string | Uint8Array>) {
      const entries = Object.entries(files);
      if (entries.length === 0) entries.push([".keep", ""]);
      for (const [file, content] of entries) {
        await h.files.write(relPath(ID, file), content, w);
      }
    }

    async function removeFile(file: string) {
      await h.files.remove(relPath(ID, file), { writer, recursive: false });
    }

    async function liveText(file: string): Promise<string | null> {
      const read = await readText(h.files, relPath(ID, file));
      return read.kind === "text" ? read.text : null;
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

    async function latestStamp(): Promise<unknown> {
      const read = await readText(h.files, historyStampOf(ID, h.format));
      if (read.kind === "missing") throw new Error("no latest stamp");
      return JSON.parse(read.text);
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
        expect(isVersionSha(versions[0]!.sha)).toBe(true);
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
        expect(
          (await rejection(store.ensureHistory("../etc"))).message,
        ).toMatch(/not a prototype id/);
      });

      test("writes the latest stamp for v0", async () => {
        await writeProto({ "index.html": "x" });
        await store.ensureHistory(ID);
        const { versions } = await history();
        expect(await latestStamp()).toEqual({ n: 0, sha: versions[0]!.sha });
      });

      test("adoptAll gives every minted-id folder a history, and skips the rest", async () => {
        await writeProto({ "index.html": "x" });
        await h.files.write(relPath("not-an-id", "index.html"), "x", w);
        await h.files.write(relPath("_template", "index.html"), "x", w);
        await store.adoptAll();
        expect((await history()).versions).toHaveLength(1);
        for (const dir of ["not-an-id", "_template"]) {
          expect(
            (
              await h.files.stat(
                relPath(HISTORY_DIR_NAME, `${dir}.${h.format}`),
              )
            ).kind,
          ).toBe("missing");
        }
      });
    });

    describe("checkpoint", () => {
      test("records a change as a new version with its fields", async () => {
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
        // A markdown heading in the request survives.
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
        expect((await history()).versions.map((v) => v.kind)).toEqual([
          "baseline",
        ]);
      });

      test("an empty subject falls back to a kind-specific one", async () => {
        await writeProto({ "index.html": "v0" });
        await store.ensureHistory(ID);
        await writeProto({ "index.html": "v1" });
        const result = await store.checkpoint(ID, {
          kind: "turn",
          subject: "  ",
        });
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
        const result = await store.checkpoint(ID, {
          kind: "manual",
          subject: "x",
        });
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

        await removeFile("styles.css");
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

        await removeFile("old.css");
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

        expect(await liveText("index.html")).toBe("v0");
        expect(await liveText("old.css")).toBe("old");
        expect(await liveText("new.js")).toBeNull();
        expect((await history()).dirty).toBe(false);
        expect(await latestStamp()).toEqual({ n: 2, sha: result.version.sha });
      });

      test("an abbreviated sha naming one version restores it", async () => {
        await writeProto({ "index.html": "v0" });
        await store.ensureHistory(ID);
        const v0 = (await history()).versions[0]!;
        await writeProto({ "index.html": "v1" });
        await store.checkpoint(ID, { kind: "manual", subject: "v1" });

        const result = await store.restoreVersion(ID, v0.sha.slice(0, 12));
        expect(result.kind).toBe("restored");
        expect(await liveText("index.html")).toBe("v0");
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
        expect(await liveText("index.html")).toBe("v0");
      });

      test("leaves untracked dot-files alone", async () => {
        await writeProto({ "index.html": "v0" });
        await store.ensureHistory(ID);
        const v0 = (await history()).versions[0]!;
        await writeProto({ "index.html": "v1", ".DS_Store": "finder" });
        await store.checkpoint(ID, { kind: "manual", subject: "v1" });

        await store.restoreVersion(ID, v0.sha);
        expect(await liveText(".DS_Store")).toBe("finder");
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

    describe("readVersionCounts", () => {
      test("no history yet: no counts", async () => {
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

      test("a history without a stamp is absent, never 0", async () => {
        await writeProto({ "index.html": "one" });
        await store.ensureHistory(ID);
        await h.files.remove(historyStampOf(ID, h.format), {
          writer,
          recursive: false,
        });
        expect(await store.readVersionCounts()).toEqual({});
      });

      test("a malformed stamp throws, naming the file", async () => {
        await writeProto({ "index.html": "one" });
        await store.ensureHistory(ID);
        await h.files.write(
          historyStampOf(ID, h.format),
          JSON.stringify({ n: "three" }),
          w,
        );
        const err = await rejection(store.readVersionCounts());
        expect(err.message).toContain("malformed version stamp");
        expect(err.message).toContain(`${ID}.${h.format}`);
      });

      test("ignores what is not a prototype's history", async () => {
        await h.files.write(
          relPath(HISTORY_DIR_NAME, `not-an-id.${h.format}`, "latest.json"),
          JSON.stringify({ n: 0, sha: "a".repeat(40) }),
          w,
        );
        await h.files.write(relPath(HISTORY_DIR_NAME, `${ID}.lock`), "", w);
        expect(await store.readVersionCounts()).toEqual({});
      });
    });
  });
}
