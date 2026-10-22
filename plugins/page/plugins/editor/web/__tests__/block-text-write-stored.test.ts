/**
 * Replay host B (`block-text-write-stored.ts`) against a stubbed transport,
 * and the `applyBlockRuns` host selection — every arm of the confirmation
 * gate: a live owner takes host A (after its `sync` when its doc is still
 * empty), a present row with no owner takes host B, an unconfirmed row that
 * THIS client re-created waits push-based for the row, a row another writer
 * removed goes straight to host B (never a wait nothing can end), memory mode
 * with no owner writes the row, and a `stale-entry` conflict is reported (and
 * the write still applied) when the block does not hold what the entry
 * expected. Every wait has a terminal exit: a rolled-back create rejects the
 * waiter, and an owner whose transport learns the block was purged stops
 * waiting on a `sync` that will never come.
 *
 * Run with `bun run test:dom plugins/page/plugins/editor`.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";

// Spread the real module: the endpoints barrel (EndpointError) calls
// `transportScoped` at load.
vi.mock(
  "@plugins/primitives/plugins/networking/web",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    subscribeWsStatus: () => () => {},
  }),
);

vi.mock("@plugins/primitives/plugins/live-state/web", () => ({
  liveStateSocketKind: () => "worktree",
}));
vi.mock("@plugins/network/plugins/live/web", () => ({
  useLiveRow: vi.fn(() => ({
    status: "loading",
    refetch: () => Promise.resolve(),
  })),
}));

import { EndpointError } from "@plugins/infra/plugins/endpoints/web";
import {
  fakeFetchEndpoint,
  type FakeEndpointAnswer,
} from "@plugins/infra/plugins/endpoints/web/testing";
import { yDocContent } from "@plugins/primitives/plugins/collab-doc/core";
import {
  blockDocInit,
  blockDocUpdate,
} from "@plugins/page/plugins/editor-collab/core";
import {
  mergeRuns,
  runsToXmlText,
  xmlTextToRuns,
  type RichText,
} from "../../core";
import { blockTextRunsOptions } from "../internal/block-text-extensions";
import { buildSeedStateFor } from "../internal/block-seed-state";
import {
  BlockDocs,
  CollabSession,
  blockDocOwnerOf,
} from "../internal/collab-session";
import {
  applyBlockRuns,
  BlockTextReplayError,
  spliceStoredBlockDoc,
  type ApplyBlockRunsArgs,
} from "../internal/block-text-write-stored";
import {
  undoConflictReportSink,
  type UndoConflictReport,
} from "../internal/undo-conflict-report";

// The editor's endpoint client, handed to host B and to every server-synced
// owner: a plain test double, so each case scripts its server.
const server = vi.fn<FakeEndpointAnswer>();
const { fetchEndpoint } = fakeFetchEndpoint(server);
/** The owners' registry, whose server is the double. */
const docs = new BlockDocs({ fetchEndpoint, socketUrl: "ws://x/worktree" });

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function stateOf(runs: RichText): Uint8Array {
  const doc = runsToXmlText(runs, blockTextRunsOptions()).doc;
  if (!doc) throw new Error("seed XmlText is not attached to a doc");
  return Y.encodeStateAsUpdate(doc);
}

function runsOfState(
  state: Uint8Array,
  deltas: readonly Uint8Array[],
): RichText {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  for (const d of deltas) Y.applyUpdate(doc, d);
  return xmlTextToRuns(yDocContent(doc), blockTextRunsOptions());
}

/**
 * A fake server holding one stored doc: doc-init answers with it (or 404s when
 * `purged`), doc-update records the delta.
 */
function fakeServer(
  stored: Uint8Array | null,
  opts?: { purged?: boolean; rejectUpdate?: number },
) {
  const inits: Uint8Array[] = [];
  const deltas: Uint8Array[] = [];
  const impl: FakeEndpointAnswer = async ({ endpoint, body }) => {
    const bytes =
      body instanceof Blob
        ? new Uint8Array(await body.arrayBuffer())
        : new Uint8Array();
    if (endpoint === blockDocInit) {
      if (opts?.purged) throw new EndpointError(404, "block not found");
      inits.push(bytes);
      // First-writer-wins: the stored state when there is one, else the seed.
      return { state: toBase64(stored ?? bytes) };
    }
    if (endpoint === blockDocUpdate) {
      if (opts?.rejectUpdate !== undefined)
        throw new EndpointError(opts.rejectUpdate, "rejected");
      deltas.push(bytes);
      return undefined;
    }
    throw new Error("unexpected endpoint");
  };
  server.mockImplementation(impl);
  return { inits, deltas };
}

const reports: UndoConflictReport[] = [];
let blockSeq = 0;
const nextId = (): string => `stored-${(blockSeq += 1)}`;

beforeEach(() => {
  vi.useFakeTimers();
  server.mockReset();
  reports.length = 0;
  undoConflictReportSink.register((r) => {
    reports.push(r);
  });
});

afterEach(async () => {
  undoConflictReportSink.register(null);
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});

describe("spliceStoredBlockDoc", () => {
  test("writes relative to the AUTHORITATIVE runs, seeded from the row", async () => {
    const stored = stateOf([{ text: "hello", marks: ["bold"] }]);
    const { inits, deltas } = fakeServer(stored);
    const rowRuns: RichText = [{ text: "lagged row" }];
    const result = await spliceStoredBlockDoc(
      fetchEndpoint,
      "b",
      rowRuns,
      (current) => mergeRuns(current, [{ text: " world" }]),
    );
    expect(result.before).toEqual([{ text: "hello", marks: ["bold"] }]);
    expect(result.after).toEqual([
      { text: "hello", marks: ["bold"] },
      { text: " world" },
    ]);
    // The doc-init proposal is the row's text (only ever used when no doc exists).
    expect(inits).toHaveLength(1);
    expect(inits[0]).toEqual(buildSeedStateFor(rowRuns));
    // The server holds the append merged onto ITS state, not onto the row.
    expect(deltas).toHaveLength(1);
    expect(runsOfState(stored, deltas)).toEqual(result.after);
  });

  test("splicing back to `before` un-appends exactly the suffix", async () => {
    const stored = stateOf([{ text: "hello" }]);
    const { deltas } = fakeServer(stored);
    const forward = await spliceStoredBlockDoc(
      fetchEndpoint,
      "b",
      [],
      (current) => mergeRuns(current, [{ text: " world" }]),
    );
    // The un-append reads the server (now holding the append) and splices back.
    const afterForward = new Y.Doc();
    Y.applyUpdate(afterForward, stored);
    Y.applyUpdate(afterForward, deltas[0]!);
    fakeServer(Y.encodeStateAsUpdate(afterForward));
    const back = await spliceStoredBlockDoc(
      fetchEndpoint,
      "b",
      [],
      () => forward.before,
    );
    expect(back.before).toEqual([{ text: "hello world" }]);
    expect(back.after).toEqual([{ text: "hello" }]);
  });

  test("equal runs post no doc-update", async () => {
    const { deltas } = fakeServer(stateOf([{ text: "same" }]));
    const result = await spliceStoredBlockDoc(
      fetchEndpoint,
      "b",
      [],
      (current) => current,
    );
    expect(result.before).toEqual(result.after);
    expect(deltas).toHaveLength(0);
    expect(server).toHaveBeenCalledTimes(1);
  });

  test("a purged block's doc-init 404 is a BlockTextReplayError with the cause", async () => {
    fakeServer(null, { purged: true });
    const err = await spliceStoredBlockDoc(
      fetchEndpoint,
      "gone",
      [],
      () => [],
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockTextReplayError);
    const replayErr = err as BlockTextReplayError;
    expect(replayErr.blockId).toBe("gone");
    expect(replayErr.cause).toBeInstanceOf(EndpointError);
    expect((replayErr.cause as EndpointError).status).toBe(404);
    expect(replayErr.message).toContain("gone");
  });

  test("a rejected doc-update is a BlockTextReplayError too", async () => {
    fakeServer(stateOf([{ text: "a" }]), { rejectUpdate: 409 });
    const err = await spliceStoredBlockDoc(fetchEndpoint, "b", [], () => [
      { text: "ab" },
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockTextReplayError);
    expect((err as BlockTextReplayError).cause).toBeInstanceOf(EndpointError);
  });
});

function argsFor(
  blockId: string,
  over: Partial<ApplyBlockRunsArgs> &
    Pick<ApplyBlockRunsArgs, "runs" | "expected">,
): ApplyBlockRunsArgs & { rowWrites: RichText[] } {
  const rowWrites: RichText[] = [];
  return {
    docs,
    blockId,
    direction: "undo",
    serverSync: true,
    rowRuns: () => [],
    writeRow: (runs) => {
      rowWrites.push(runs);
    },
    rowPresent: () => true,
    rowLive: () => true,
    waitRowPresent: () => Promise.resolve(),
    ...over,
    rowWrites,
  };
}

/** A wait that must never be taken: it hangs forever and flags the call. */
function neverWait(): { wait: () => Promise<void>; taken: () => boolean } {
  let taken = false;
  return {
    wait: () => {
      taken = true;
      return new Promise<void>(() => {});
    },
    taken: () => taken,
  };
}

describe("applyBlockRuns", () => {
  test("memory mode with no owner writes the row and touches no transport", async () => {
    fakeServer(null);
    const args = argsFor(nextId(), {
      serverSync: false,
      runs: [{ text: "row" }],
      expected: [],
    });
    await applyBlockRuns(args);
    expect(args.rowWrites).toEqual([[{ text: "row" }]]);
    expect(server).not.toHaveBeenCalled();
  });

  test("no owner, row present ⇒ host B, checked against the authoritative runs", async () => {
    const stored = stateOf([{ text: "server" }]);
    const { deltas } = fakeServer(stored);
    const args = argsFor(nextId(), {
      runs: [{ text: "undone" }],
      expected: [{ text: "server" }],
    });
    await applyBlockRuns(args);
    expect(runsOfState(stored, deltas)).toEqual([{ text: "undone" }]);
    expect(reports).toHaveLength(0);
    expect(args.rowWrites).toHaveLength(0);
  });

  test("a stale entry on host B is reported and applied anyway", async () => {
    const stored = stateOf([{ text: "someone else wrote this" }]);
    const { deltas } = fakeServer(stored);
    const id = nextId();
    const args = argsFor(id, {
      direction: "redo",
      runs: [{ text: "redone" }],
      expected: [{ text: "mine" }],
    });
    await applyBlockRuns(args);
    expect(runsOfState(stored, deltas)).toEqual([{ text: "redone" }]);
    expect(reports).toEqual([
      {
        reason: "stale-entry",
        blockId: id,
        direction: "redo",
        expectedLength: "mine".length,
        actualLength: "someone else wrote this".length,
      },
    ]);
  });

  test("no owner, row NOT present but in OUR rows (re-created) ⇒ waits for the row, then host B", async () => {
    const stored = stateOf([{ text: "restored" }]);
    const { deltas } = fakeServer(stored);
    let present = false;
    let confirm: () => void = () => {};
    const waited = new Promise<void>((r) => {
      confirm = r;
    });
    const args = argsFor(nextId(), {
      runs: [{ text: "after" }],
      expected: [{ text: "restored" }],
      rowPresent: () => present,
      rowLive: () => true,
      waitRowPresent: () => waited,
    });
    const done = applyBlockRuns(args);
    await Promise.resolve();
    // Nothing is doc-inited for a row the server may not have.
    expect(server).not.toHaveBeenCalled();
    present = true;
    confirm();
    await done;
    expect(runsOfState(stored, deltas)).toEqual([{ text: "after" }]);
  });

  test("no owner, row in NEITHER set (another writer trashed it) ⇒ host B now, no wait", async () => {
    // The trashed row's doc SURVIVES (a delete is a trash): doc-init answers it.
    const stored = stateOf([{ text: "trashed elsewhere" }]);
    const { deltas } = fakeServer(stored);
    const never = neverWait();
    const args = argsFor(nextId(), {
      runs: [{ text: "undone" }],
      expected: [{ text: "trashed elsewhere" }],
      rowPresent: () => false,
      rowLive: () => false,
      waitRowPresent: never.wait,
    });
    await applyBlockRuns(args);
    expect(never.taken()).toBe(false);
    expect(runsOfState(stored, deltas)).toEqual([{ text: "undone" }]);
    expect(reports).toHaveLength(0);
  });

  test("no owner, PURGED block ⇒ BlockTextReplayError settles the turn, and the next replay runs", async () => {
    fakeServer(null, { purged: true });
    const never = neverWait();
    const purged = nextId();
    const failed = applyBlockRuns(
      argsFor(purged, {
        runs: [{ text: "undone" }],
        expected: [{ text: "gone" }],
        rowPresent: () => false,
        rowLive: () => false,
        waitRowPresent: never.wait,
      }),
    );
    // The turn SETTLES (a rejection, not a pending promise) — which is what
    // lets the primitive's `finally` hand the queue to the next turn.
    const err = await failed.catch((e: unknown) => e);
    expect(never.taken()).toBe(false);
    expect(err).toBeInstanceOf(BlockTextReplayError);
    expect((err as BlockTextReplayError).blockId).toBe(purged);
    expect((err as BlockTextReplayError).cause).toBeInstanceOf(EndpointError);

    // The queued turn behind it: an ordinary host-B replay on another block.
    const stored = stateOf([{ text: "next" }]);
    const { deltas } = fakeServer(stored);
    await applyBlockRuns(
      argsFor(nextId(), {
        runs: [{ text: "next undone" }],
        expected: [{ text: "next" }],
      }),
    );
    expect(runsOfState(stored, deltas)).toEqual([{ text: "next undone" }]);
  });

  test("a re-created row whose optimistic create is ROLLED BACK ⇒ the wait rejects loudly, nothing doc-inits", async () => {
    fakeServer(null);
    let reject: (err: Error) => void = () => {};
    const waited = new Promise<void>((_, r) => {
      reject = r;
    });
    const id = nextId();
    const pending = applyBlockRuns(
      argsFor(id, {
        runs: [{ text: "undone" }],
        expected: [{ text: "restored" }],
        rowPresent: () => false,
        rowLive: () => true,
        waitRowPresent: () => waited,
      }),
    );
    await Promise.resolve();
    expect(server).not.toHaveBeenCalled();
    // The push that denies the create: the row left the client's rows without
    // ever entering server truth. The editor context rejects its waiters.
    reject(new Error(`row "${id}" create rolled back`));
    await expect(pending).rejects.toThrow("rolled back");
    expect(server).not.toHaveBeenCalled();
  });

  test("a live owner whose doc holds content ⇒ host A, no transport", async () => {
    fakeServer(null);
    const id = nextId();
    const session = CollabSession.start(
      docs,
      id,
      () => buildSeedStateFor([{ text: "seeded" }]),
      "present",
      false,
    );
    const { owner } = session;
    owner.replicaConnection.acquire(); // the local provider seeds at connect()
    try {
      expect(owner.runsNow() as RichText).toEqual([{ text: "seeded" }]);
      const args = argsFor(id, {
        serverSync: false,
        runs: [{ text: "replayed", marks: ["italic"] }],
        expected: [{ text: "seeded" }],
      });
      await applyBlockRuns(args);
      expect(owner.runsNow() as RichText).toEqual([
        { text: "replayed", marks: ["italic"] },
      ]);
      expect(server).not.toHaveBeenCalled();
      expect(args.rowWrites).toHaveLength(0);
      expect(reports).toHaveLength(0);

      // A mismatch on host A reports against the owner's own runs.
      await applyBlockRuns(
        argsFor(id, {
          serverSync: false,
          direction: "undo",
          runs: [{ text: "again" }],
          expected: [{ text: "not what it holds" }],
        }),
      );
      expect(owner.runsNow() as RichText).toEqual([{ text: "again" }]);
      expect(reports).toEqual([
        {
          reason: "stale-entry",
          blockId: id,
          direction: "undo",
          expectedLength: "not what it holds".length,
          actualLength: "replayed".length,
        },
      ]);
    } finally {
      owner.replicaConnection.release();
      session.end();
      await vi.runOnlyPendingTimersAsync();
      expect(blockDocOwnerOf(docs, id)).toBeNull();
    }
  });

  test("a live owner with an EMPTY unsynced doc waits for its sync, then host A", async () => {
    fakeServer(null);
    const id = nextId();
    const session = CollabSession.start(
      docs,
      id,
      () => buildSeedStateFor([{ text: "row" }]),
      "present",
      true,
    );
    const { owner } = session;
    owner.replicaConnection.acquire(); // connected, but no server answer yet
    try {
      expect(owner.provider.isSynced).toBe(false);
      expect(owner.doc.store.clients.size).toBe(0);
      const done = applyBlockRuns(
        argsFor(id, {
          runs: [{ text: "undone" }],
          expected: [{ text: "stored" }],
        }),
      );
      await Promise.resolve();
      expect(server).not.toHaveBeenCalled();
      expect(owner.runsNow() as RichText).toEqual([]);
      // The subscription answers: the doc hydrates, `sync` fires, host A runs.
      owner.provider.onServerState(toBase64(stateOf([{ text: "stored" }])));
      await done;
      expect(owner.runsNow() as RichText).toEqual([{ text: "undone" }]);
      expect(reports).toHaveLength(0);
    } finally {
      owner.replicaConnection.release();
      session.end();
      await vi.runOnlyPendingTimersAsync();
    }
  });

  test("an owner finalized while a replay waits on it ⇒ the block is resolved again (host B)", async () => {
    const stored = stateOf([{ text: "stored" }]);
    const { deltas } = fakeServer(stored);
    const id = nextId();
    const session = CollabSession.start(
      docs,
      id,
      () => buildSeedStateFor([{ text: "row" }]),
      "present",
      true,
    );
    session.owner.replicaConnection.acquire();
    const done = applyBlockRuns(
      argsFor(id, {
        runs: [{ text: "undone" }],
        expected: [{ text: "stored" }],
      }),
    );
    await Promise.resolve();
    session.owner.replicaConnection.release();
    session.end();
    await vi.runOnlyPendingTimersAsync();
    expect(blockDocOwnerOf(docs, id)).toBeNull();
    await done;
    expect(runsOfState(stored, deltas)).toEqual([{ text: "undone" }]);
  });

  test("a live owner whose transport learns the block was PURGED while a replay waits on its sync ⇒ host B's 404, not a hang", async () => {
    const id = nextId();
    const session = CollabSession.start(
      docs,
      id,
      () => buildSeedStateFor([{ text: "row" }]),
      "present",
      true,
    );
    const { owner } = session;
    owner.replicaConnection.acquire();
    try {
      expect(owner.provider.isSynced).toBe(false);
      expect(owner.doc.store.clients.size).toBe(0);
      // Every doc-init 404s: the block was purged under a still-mounted editor.
      fakeServer(null, { purged: true });
      // The handler is attached up front: the rejection lands while the
      // transport settles below, and must not read as unhandled meanwhile.
      const outcome = applyBlockRuns(
        argsFor(id, {
          runs: [{ text: "undone" }],
          expected: [{ text: "stored" }],
        }),
      ).catch((e: unknown) => e);
      await Promise.resolve();
      expect(server).not.toHaveBeenCalled();
      // The subscription answers "no doc"; the provider's own doc-init then
      // 404s and latches `blockGone` — `sync` will never fire.
      owner.provider.onServerState(null);
      await vi.runOnlyPendingTimersAsync();
      expect(owner.provider.isBlockGone).toBe(true);
      expect(owner.provider.isSynced).toBe(false);
      const err = await outcome;
      expect(err).toBeInstanceOf(BlockTextReplayError);
      expect((err as BlockTextReplayError).blockId).toBe(id);
      expect((err as BlockTextReplayError).cause).toBeInstanceOf(EndpointError);
      expect((err as BlockTextReplayError).cause).toHaveProperty("status", 404);
      // The owner's doc was never spliced: a purged doc can never flush.
      expect(owner.runsNow() as RichText).toEqual([]);
    } finally {
      owner.replicaConnection.release();
      session.end();
      await vi.runOnlyPendingTimersAsync();
    }
  });
});
