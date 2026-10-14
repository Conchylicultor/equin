import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  submitTranscription,
  TranscriptionRejectedError,
  type SubmitDeps,
} from "./submit";
import { resolveWorkspaceFile, WorkspaceEscapeError } from "./workspace-file";
import { TRANSCRIPTION_PROFILE_ID } from "./profile-input";

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

let root: string;
let ws: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "transcription-submit-"));
  ws = join(root, "ws");
  await mkdir(join(ws, "sub"), { recursive: true });
  await writeFile(join(ws, "score.musicxml"), "<score-partwise/>");
  await writeFile(join(ws, "sub", "b.musicxml"), "<b/>");
  await writeFile(join(root, "secret.xml"), "<secret/>");
  await symlink(join(root, "secret.xml"), join(ws, "link.xml"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveWorkspaceFile", () => {
  test("resolves a file inside the workspace, relative or absolute", async () => {
    expect(await resolveWorkspaceFile(ws, "score.musicxml")).toEndWith(
      "/ws/score.musicxml",
    );
    expect(await resolveWorkspaceFile(ws, "sub/../sub/b.musicxml")).toEndWith(
      "/ws/sub/b.musicxml",
    );
    expect(
      await resolveWorkspaceFile(ws, join(ws, "score.musicxml")),
    ).toEndWith("/ws/score.musicxml");
  });

  test("rejects every way out", async () => {
    for (const p of [
      "../secret.xml",
      join(root, "secret.xml"),
      "link.xml",
      ".",
      "sub/../..",
    ]) {
      expect(await rejection(resolveWorkspaceFile(ws, p))).toBeInstanceOf(
        WorkspaceEscapeError,
      );
    }
  });

  test("a missing file throws", async () => {
    expect(
      (await rejection(resolveWorkspaceFile(ws, "nope.xml"))).message,
    ).toContain("ENOENT");
  });
});

class FakeParseError extends Error {}

function fakes(opts: { importThrows?: Error; profile?: string } = {}) {
  const calls = {
    imported: [] as { songId: string; xml: string; fileName: string }[],
    ready: [] as string[],
    delivered: [] as string[],
  };
  const deps: SubmitDeps = {
    workspaceOf: async () => ({
      path: ws,
      spec: {
        kind: "scratch",
        profile: opts.profile ?? TRANSCRIPTION_PROFILE_ID,
        input: {
          songId: "song-abc",
          source: { kind: "url", url: "https://x.test/v" },
        },
      },
    }),
    importMusicXml: async (args) => {
      if (opts.importThrows) throw opts.importThrows;
      calls.imported.push(args);
    },
    isParseError: (err): err is Error => err instanceof FakeParseError,
    markReady: async (songId) => {
      calls.ready.push(songId);
    },
    recordDelivery: async (conversationId) => {
      calls.delivered.push(conversationId);
    },
  };
  return { deps, calls };
}

describe("submitTranscription", () => {
  test("imports the file into the launch's song and marks it ready", async () => {
    const { deps, calls } = fakes();
    const out = await submitTranscription(
      { conversationId: "conv-1", path: "score.musicxml" },
      deps,
    );
    expect(String(out.songId)).toBe("song-abc");
    expect(calls.imported).toEqual([
      {
        songId: "song-abc",
        xml: "<score-partwise/>",
        fileName: "score.musicxml",
      },
    ]);
    expect(calls.ready).toEqual(["song-abc"]);
    expect(calls.delivered).toEqual(["conv-1"]);
  });

  test("a parse error comes back as feedback, and nothing is marked", async () => {
    const { deps, calls } = fakes({
      importThrows: new FakeParseError("[musicxml] <kind> in measure 3: bad"),
    });
    const run = submitTranscription(
      { conversationId: "conv-1", path: "score.musicxml" },
      deps,
    );
    const err = await rejection(run);
    expect(err).toBeInstanceOf(TranscriptionRejectedError);
    expect(err.message).toContain("<kind> in measure 3");
    expect(calls.ready).toEqual([]);
    expect(calls.delivered).toEqual([]);
  });

  test("any other import failure propagates as is", async () => {
    const boom = new Error("db down");
    const { deps, calls } = fakes({ importThrows: boom });
    expect(
      await rejection(
        submitTranscription(
          { conversationId: "conv-1", path: "score.musicxml" },
          deps,
        ),
      ),
    ).toBe(boom);
    expect(calls.ready).toEqual([]);
  });

  test("refuses a path outside the workspace", async () => {
    const { deps, calls } = fakes();
    expect(
      await rejection(
        submitTranscription(
          { conversationId: "conv-1", path: "../secret.xml" },
          deps,
        ),
      ),
    ).toBeInstanceOf(WorkspaceEscapeError);
    expect(calls.imported).toEqual([]);
  });

  test("refuses a conversation of another profile", async () => {
    const { deps, calls } = fakes({ profile: "other.profile" });
    expect(
      (
        await rejection(
          submitTranscription(
            { conversationId: "conv-1", path: "score.musicxml" },
            deps,
          ),
        )
      ).message,
    ).toContain("is not a sonata.transcription workspace");
    expect(calls.imported).toEqual([]);
  });
});
