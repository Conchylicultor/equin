/**
 * Provider-contract tests for `LiveStateYjsProvider` (per-block CRDT plan).
 * Run with `bun run test:dom plugins/page/plugins/editor`.
 *
 * These pin the four hardening invariants at the seam where they live:
 *
 *  1. REOPEN / pre-seed discriminator — `connect()` may legally run BEFORE any
 *     of the owning hook's parent effects (`markBlockRowConfirmed`,
 *     `onServerState`): child effects fire before parent effects, and nothing
 *     in `CollaborationPlugin`'s contract orders its connect after them (today
 *     it happens to defer connect by two internal commits — an accident of its
 *     implementation, not a guarantee). The provider must therefore carry a
 *     RENDER-ACCURATE `RowTruth` from construction: an existing block
 *     (`"present"` at first render) must NEVER pre-seed on connect — its
 *     data.text-derived seed would be an independent CRDT encoding of the
 *     stored doc's content and merge as DUPLICATED text — while a client-
 *     minted block (`"unseen"`) must still pre-seed instantly (Stage 4a).
 *
 *  2. A RE-CREATED row (`"removed"` — undo of a delete) has a stored doc that
 *     SURVIVED the delete, because every delete is a trash. It must bind to
 *     that doc like an existing block does: no pre-seed, the subscription's
 *     state applied exactly once, no doc-init. Only a positive `null` answer
 *     ("no doc") licenses the seed, at that moment — and the doc-init the
 *     confirmation then posts carries those exact bytes, so the response merges
 *     as a no-op.
 *
 *  3. A doc-update 409 must not wedge the provider: it re-arms the init path
 *     and lets doc-init arbitrate — 404 (block really deleted) is a quiet
 *     terminal stop; success (block alive, doc row unexpectedly gone) recovers
 *     loudly by re-seeding from the FULL local doc state and resuming flushes.
 *
 *  4. Teardown must not lose buffered edits: with updates still queued the
 *     provider reports NOT ready-for-teardown, and the (single-slot) teardown
 *     listener fires push-based once a reconnect drains the queue — even
 *     though the editor already disconnected.
 *
 *  5. The save state the sync-status cloud reads must not lie: `syncing` while
 *     bytes are owed (INCLUDING offline, where they are queued and retried),
 *     `error` only on a durable HTTP rejection, `idle` + a `lastFlushedAt`
 *     stamp only once the server has acked everything.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";

const wsStatusListeners: Array<(ev: { status: string; url: string }) => void> =
  [];
// Spread the real module: the endpoints barrel (EndpointError) calls
// `transportScoped` at load.
vi.mock(
  "@plugins/primitives/plugins/networking/web",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    subscribeWsStatus: (cb: (ev: { status: string; url: string }) => void) => {
      wsStatusListeners.push(cb);
      return () => {
        const i = wsStatusListeners.indexOf(cb);
        if (i >= 0) wsStatusListeners.splice(i, 1);
      };
    },
  }),
);

vi.mock("@plugins/primitives/plugins/live-state/web", () => ({
  liveStateSocketKind: () => "worktree",
}));

import { EndpointError } from "@plugins/infra/plugins/endpoints/web";
import {
  fakeFetchEndpoint,
  type FakeEndpointAnswer,
} from "@plugins/infra/plugins/endpoints/web/testing";
import {
  blockDocInit,
  blockDocUpdate,
} from "@plugins/page/plugins/editor-collab/core";
import { LiveStateYjsProvider } from "../internal/live-state-yjs-provider";

// The provider's endpoint client, injected at construction (the editor's
// transport): a plain test double, so each case scripts its answers.
const server = vi.fn<FakeEndpointAnswer>();
const { fetchEndpoint } = fakeFetchEndpoint(server);

/** Deterministic full-state encoding: one XmlText "root" holding `text`. */
function encodedState(clientID: number, text: string): Uint8Array {
  const d = new Y.Doc();
  d.clientID = clientID;
  d.get("root", Y.XmlText).insert(0, text);
  return Y.encodeStateAsUpdate(d);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function docText(doc: Y.Doc): string {
  return doc.get("root", Y.XmlText).toString();
}

/** Count non-overlapping occurrences of `needle` in `hay`. */
function count(hay: string, needle: string): number {
  let n = 0;
  for (
    let i = hay.indexOf(needle);
    i >= 0;
    i = hay.indexOf(needle, i + needle.length)
  )
    n++;
  return n;
}

/** Simulate a local (binding-origin) edit: append `text` to the content root. */
function localEdit(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const root = doc.get("root", Y.XmlText);
    root.insert(root.length, text);
  }, "binding");
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {});
}

/** Advance the flush debounce and let the resulting async flush settle. */
async function runFlush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(400);
  await flushMicrotasks();
}

beforeEach(() => {
  vi.useFakeTimers();
  server.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  wsStatusListeners.length = 0;
  vi.restoreAllMocks();
});

describe("finding #1 — reopen of an existing block must not pre-seed", () => {
  test("connect() BEFORE the latch/serverState never seeds a row-confirmed block", async () => {
    const doc = new Y.Doc();
    const buildSeedState = vi.fn(() => encodedState(111, "hello world"));
    // Existing block: row confirmed at the editor's FIRST render (it only
    // renders because it is in the authoritative rows) — threaded into the
    // provider at construction, NOT via the later parent effect.
    const provider = new LiveStateYjsProvider(
      doc,
      "blk-existing",
      buildSeedState,
      "present",
      { fetchEndpoint, socketUrl: "ws://x/worktree" },
    );

    // The legal worst-case order: connect fires before markBlockRowConfirmed
    // and before the subscription delivers.
    provider.connect();
    expect(buildSeedState).not.toHaveBeenCalled();
    expect(docText(doc)).toBe(""); // no pre-seed — waits for server truth

    // The stored doc arrives: the SAME visible text under a different
    // clientID (original seed + live edits). Must be the ONLY copy.
    provider.onServerState(toBase64(encodedState(222, "hello world")));
    expect(count(docText(doc), "hello world")).toBe(1);

    // Later latch (the parent effect) stays a no-op for seeding.
    provider.markBlockRowConfirmed();
    await flushMicrotasks();
    expect(buildSeedState).not.toHaveBeenCalled();
    expect(count(docText(doc), "hello world")).toBe(1);
    provider.destroy();
  });

  test("Stage 4a preserved: an unconfirmed (client-minted) block pre-seeds instantly at connect", () => {
    const doc = new Y.Doc();
    const buildSeedState = vi.fn(() => encodedState(111, "split tail"));
    const provider = new LiveStateYjsProvider(
      doc,
      "blk-fresh",
      buildSeedState,
      "unseen",
      { fetchEndpoint, socketUrl: "ws://x/worktree" },
    );

    provider.connect();
    // Instant local hydration — the editor shows the tail immediately.
    expect(docText(doc)).toBe("split tail");

    // The eventual authoritative state (its own doc-init echo / a racing
    // tab's byte-identical deterministic seed) merges as a no-op.
    provider.onServerState(toBase64(encodedState(111, "split tail")));
    expect(count(docText(doc), "split tail")).toBe(1);
    provider.destroy();
  });
});

describe("finding #3 — a doc-update 409 must not wedge the provider", () => {
  async function syncedProvider(
    blockId: string,
  ): Promise<{ doc: Y.Doc; provider: LiveStateYjsProvider }> {
    const doc = new Y.Doc();
    const provider = new LiveStateYjsProvider(
      doc,
      blockId,
      () => encodedState(111, "seed"),
      "present",
      { fetchEndpoint, socketUrl: "ws://x/worktree" },
    );
    provider.connect();
    provider.onServerState(toBase64(encodedState(222, "stored")));
    await flushMicrotasks();
    return { doc, provider };
  }

  test("unexpected 409 with the block alive: re-inits from the LOCAL doc and resumes flushing", async () => {
    const { doc, provider } = await syncedProvider("blk-live");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    localEdit(doc, " typed");
    // First flush 409s (doc row gone); the doc-init probe then SUCCEEDS
    // (block alive) — echoing back whatever state was posted.
    server
      .mockRejectedValueOnce(new EndpointError(409, null))
      .mockImplementationOnce(async ({ opts }) => {
        const body = (opts as unknown as { body: Blob }).body;
        const buf = await body.arrayBuffer();
        return { state: toBase64(new Uint8Array(buf)) };
      })
      .mockResolvedValue(undefined);

    await runFlush();
    await flushMicrotasks();

    // POST #1: the failed doc-update. POST #2: the doc-init probe, seeded
    // from the FULL local doc state (never the stale data.text seed — that
    // would re-encode content the doc already holds and duplicate).
    expect(server.mock.calls.length).toBeGreaterThanOrEqual(2);
    const initBody = server.mock.calls[1]![0].opts as { body: Blob };
    const initBytes = new Uint8Array(await initBody.body.arrayBuffer());
    const replay = new Y.Doc();
    Y.applyUpdate(replay, initBytes);
    expect(docText(replay)).toContain("stored typed");
    // Loud: this interleave is unexpected (only block deletion cascades the row).
    expect(errorSpy).toHaveBeenCalled();

    // The queue drains (full-state safety update + the requeued batch) and
    // the loop is live again: a NEW edit flushes — not wedged.
    await runFlush();
    const callsBefore = server.mock.calls.length;
    localEdit(doc, " more");
    await runFlush();
    expect(server.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(provider.readyForTeardown).toBe(true);
    provider.destroy();
  });

  test("409 with the block really deleted (doc-init 404): quiet terminal stop, ready for teardown", async () => {
    const { doc, provider } = await syncedProvider("blk-deleted");
    localEdit(doc, " typed");
    server
      .mockRejectedValueOnce(new EndpointError(409, null))
      .mockRejectedValueOnce(new EndpointError(404, null));

    await runFlush();
    await flushMicrotasks();

    // Server-confirmed absence: pending bytes are deliberately dropped (the
    // content moved with the merge / went with the delete) and the provider
    // is finalizable — never a buffering-forever wedge, never a loud throw.
    expect(provider.readyForTeardown).toBe(true);
    provider.destroy();
  });
});

describe("finding #4 — teardown must not lose buffered edits over a transient outage", () => {
  test("disconnect with a failed flush retains the bytes; reconnect drains and signals teardown-ready", async () => {
    const doc = new Y.Doc();
    const provider = new LiveStateYjsProvider(
      doc,
      "blk-teardown",
      () => encodedState(111, "seed"),
      "present",
      { fetchEndpoint, socketUrl: "ws://x/worktree" },
    );
    provider.connect();
    provider.onServerState(toBase64(encodedState(222, "stored")));
    await flushMicrotasks();

    // Type, then unmount during a transient outage: the eager teardown flush
    // rejects at the network level.
    localEdit(doc, " last words");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    server.mockRejectedValueOnce(new TypeError("network down"));
    provider.disconnect();
    await flushMicrotasks();
    expect(warnSpy).toHaveBeenCalled(); // offline buffering surfaced once

    // The bytes are re-queued and unreachable by any editor — the registry
    // must NOT destroy yet.
    expect(provider.readyForTeardown).toBe(false);
    const onReady = vi.fn();
    provider.setTeardownReadyListener(onReady);

    // The tab reconnects (live-state socket reopens). Even though the editor
    // is disconnected, the retained provider drains its queue…
    server.mockResolvedValue(undefined);
    for (const cb of [...wsStatusListeners])
      cb({ status: "open", url: "ws://x/worktree" });
    await flushMicrotasks();

    // …and signals the registry push-based that destroying is now safe.
    expect(onReady).toHaveBeenCalled();
    expect(provider.readyForTeardown).toBe(true);
    const flushed = server.mock.calls.at(-1)![0].opts as { body: Blob };
    const bytes = new Uint8Array(await flushed.body.arrayBuffer());
    const replay = new Y.Doc();
    Y.applyUpdate(replay, toBytesSafe(encodedState(222, "stored")));
    Y.applyUpdate(replay, bytes);
    expect(docText(replay)).toContain("last words");
    provider.destroy();
  });
});

/** Identity helper (keeps the replay call sites uniform). */
function toBytesSafe(bytes: Uint8Array): Uint8Array {
  return bytes;
}

/**
 * Run `body` with the process's `unhandledRejection` listeners swapped for a
 * collector, and return what was rejected. A durable HTTP failure is rethrown
 * out of the `void this.flushLoop()` / `void this.initDoc()` call sites BY
 * DESIGN (fail loudly — it reaches the global crash reporter in the browser), so
 * a test that exercises that path must observe the rejection rather than let the
 * runner treat it as an accident.
 */
async function withUnhandledRejections(
  body: () => Promise<void>,
): Promise<unknown[]> {
  const prior = process.listeners("unhandledRejection");
  const collected: unknown[] = [];
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (reason) => collected.push(reason));
  try {
    await body();
    // Node emits `unhandledRejection` at the end of a real event-loop turn,
    // which fake timers never reach — hop onto real ones for a single tick so
    // the rejection lands in `collected` before the runner's listeners return.
    vi.useRealTimers();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    vi.useFakeTimers();
  } finally {
    process.removeAllListeners("unhandledRejection");
    for (const l of prior) process.on("unhandledRejection", l as never);
  }
  return collected;
}

describe("finding #5 — the save state reported to the sync-status cloud", () => {
  async function syncedProvider(
    blockId: string,
  ): Promise<{ doc: Y.Doc; provider: LiveStateYjsProvider }> {
    const doc = new Y.Doc();
    const provider = new LiveStateYjsProvider(
      doc,
      blockId,
      () => encodedState(111, "seed"),
      "present",
      { fetchEndpoint, socketUrl: "ws://x/worktree" },
    );
    provider.connect();
    provider.onServerState(toBase64(encodedState(222, "stored")));
    await flushMicrotasks();
    return { doc, provider };
  }

  test("idle → syncing on the first keystroke → idle + lastFlushedAt once the queue drains", async () => {
    const { doc, provider } = await syncedProvider("blk-phases");
    const onChange = vi.fn();
    const unsubscribe = provider.onSaveState(onChange);

    expect(provider.getSaveState()).toEqual({
      phase: "idle",
      lastFlushedAt: null,
    });

    server.mockResolvedValue(undefined);
    localEdit(doc, " typed");
    // The bytes are owed to the server from the keystroke edge — NOT only once
    // the 300ms debounce expires.
    expect(provider.getSaveState().phase).toBe("syncing");
    expect(onChange).toHaveBeenCalledTimes(1);

    // Memoized snapshot: identity is stable while nothing changed, so a
    // `useSyncExternalStore` consumer can't loop.
    expect(provider.getSaveState()).toBe(provider.getSaveState());

    await runFlush();
    const saved = provider.getSaveState();
    expect(saved.phase).toBe("idle");
    expect(saved.lastFlushedAt).toBeGreaterThan(0);

    unsubscribe();
    provider.destroy();
  });

  test("OFFLINE is not an error: a network-level rejection stays `syncing` and never stamps a save", async () => {
    const { doc, provider } = await syncedProvider("blk-offline");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    server.mockRejectedValue(new TypeError("network down"));
    localEdit(doc, " typed");
    await runFlush();

    // The bytes are re-queued at the head and retried push-based — nothing is
    // lost, so the cloud must keep spinning rather than cry "Couldn't save".
    expect(provider.getSaveState()).toEqual({
      phase: "syncing",
      lastFlushedAt: null,
    });

    // The reconnect edge drains them and only then is the save stamped.
    server.mockReset();
    server.mockResolvedValue(undefined);
    for (const cb of [...wsStatusListeners])
      cb({ status: "open", url: "ws://x/worktree" });
    await flushMicrotasks();

    const saved = provider.getSaveState();
    expect(saved.phase).toBe("idle");
    expect(saved.lastFlushedAt).toBeGreaterThan(0);
    provider.destroy();
  });

  test("a durable (non-409) HTTP rejection on flush → `error`, thrown loudly; retryFlush recovers", async () => {
    const { doc, provider } = await syncedProvider("blk-rejected");

    server.mockRejectedValueOnce(new EndpointError(500, null));
    localEdit(doc, " typed");
    const rejections = await withUnhandledRejections(() => runFlush());

    // Fail loudly: the rejection still escapes (it reaches the crash reporter).
    expect(rejections.some((r) => r instanceof EndpointError)).toBe(true);
    expect(provider.getSaveState()).toEqual({
      phase: "error",
      lastFlushedAt: null,
    });

    // Retry clears the error and re-runs the flush over the SAME re-queued bytes.
    server.mockResolvedValue(undefined);
    provider.retryFlush();
    await flushMicrotasks();

    const saved = provider.getSaveState();
    expect(saved.phase).toBe("idle");
    expect(saved.lastFlushedAt).toBeGreaterThan(0);
    const flushed = server.mock.calls.at(-1)![0].opts as { body: Blob };
    const bytes = new Uint8Array(await flushed.body.arrayBuffer());
    const replay = new Y.Doc();
    Y.applyUpdate(replay, encodedState(222, "stored"));
    Y.applyUpdate(replay, bytes);
    expect(docText(replay)).toContain("typed");
    provider.destroy();
  });

  test("blockGone (409 → doc-init 404) is `idle`, not `error`: the bytes were deliberately dropped", async () => {
    const { doc, provider } = await syncedProvider("blk-gone");
    localEdit(doc, " typed");
    server
      .mockRejectedValueOnce(new EndpointError(409, null))
      .mockRejectedValueOnce(new EndpointError(404, null));

    await runFlush();
    await flushMicrotasks();

    // The content already moved with the merge / went with the delete — there
    // is nothing for the user to save, so the cloud must not accuse anyone.
    expect(provider.getSaveState().phase).toBe("idle");
    expect(provider.readyForTeardown).toBe(true);
    provider.destroy();
  });
});

describe('finding #2 — a re-created row (RowTruth "removed") binds to its surviving doc', () => {
  /** Bytes of a doc-init POST body, as the server would read them. */
  async function postedBytes(call: number): Promise<Uint8Array> {
    const opts = server.mock.calls[call]![0].opts as { body: Blob };
    return new Uint8Array(await opts.body.arrayBuffer());
  }

  test("removed + pending subscription: no pre-seed; the later state applies exactly once, and nothing doc-inits", async () => {
    const doc = new Y.Doc();
    const buildSeedState = vi.fn(() => encodedState(111, "hello world"));
    const provider = new LiveStateYjsProvider(
      doc,
      "blk-removed-cold",
      buildSeedState,
      "removed",
      { fetchEndpoint, socketUrl: "ws://x/worktree" },
    );
    expect(provider.mayHaveStoredDoc).toBe(true);

    // Cold: the subscription has not answered when the binding connects. The
    // row is unconfirmed exactly like a split tail — but its doc may survive,
    // so nothing may be seeded here.
    provider.connect();
    expect(buildSeedState).not.toHaveBeenCalled();
    expect(docText(doc)).toBe("");

    // The surviving doc arrives (same visible text under the stored clientID,
    // i.e. NOT byte-identical to any seed). It must be the only copy.
    provider.onServerState(toBase64(encodedState(222, "hello world")));
    await flushMicrotasks();
    expect(count(docText(doc), "hello world")).toBe(1);
    expect(provider.isSynced).toBe(true);

    // The confirmation push lifts the FK gate — a no-op here: the doc is
    // synced, so there is nothing to init.
    provider.markBlockRowConfirmed();
    await flushMicrotasks();
    expect(server).not.toHaveBeenCalled();
    expect(buildSeedState).not.toHaveBeenCalled();
    expect(count(docText(doc), "hello world")).toBe(1);
    provider.destroy();
  });

  test("removed, warm path: a state delivered BEFORE connect applies once at connect, and nothing doc-inits", async () => {
    const doc = new Y.Doc();
    const buildSeedState = vi.fn(() => encodedState(111, "hello world"));
    const provider = new LiveStateYjsProvider(
      doc,
      "blk-removed-warm",
      buildSeedState,
      "removed",
      { fetchEndpoint, socketUrl: "ws://x/worktree" },
    );

    // Warm navigation: the cached subscription value lands before the binding
    // exists. It is HELD (never applied into a doc no binding watches)…
    provider.onServerState(toBase64(encodedState(222, "hello world")));
    expect(docText(doc)).toBe("");
    // …and applied at connect(), with no seed in between.
    provider.connect();
    expect(count(docText(doc), "hello world")).toBe(1);
    expect(buildSeedState).not.toHaveBeenCalled();

    provider.markBlockRowConfirmed();
    await flushMicrotasks();
    expect(server).not.toHaveBeenCalled();
    expect(count(docText(doc), "hello world")).toBe(1);
    provider.destroy();
  });

  test("unseen still pre-seeds at connect, and its doc-init body is byte-identical to the pre-applied seed", async () => {
    const doc = new Y.Doc();
    const seed = encodedState(111, "split tail");
    const provider = new LiveStateYjsProvider(
      doc,
      "blk-unseen",
      () => seed,
      "unseen",
      { fetchEndpoint, socketUrl: "ws://x/worktree" },
    );
    expect(provider.mayHaveStoredDoc).toBe(false);

    provider.connect();
    expect(docText(doc)).toBe("split tail"); // instant

    // The subscription answers "no doc" and the row is confirmed: ONE doc-init,
    // carrying exactly the bytes already in the doc, whose echo merges as a
    // no-op.
    server.mockResolvedValue({ state: toBase64(seed) });
    provider.onServerState(null);
    provider.markBlockRowConfirmed();
    await flushMicrotasks();
    expect(server).toHaveBeenCalledTimes(1);
    expect(await postedBytes(0)).toEqual(seed);
    expect(count(docText(doc), "split tail")).toBe(1);
    expect(provider.isSynced).toBe(true);
    provider.destroy();
  });

  test("removed + a positive null answer + confirmation: the seed is shown at the answer, posted once, and its echo is a no-op", async () => {
    const doc = new Y.Doc();
    const seed = encodedState(111, "restored");
    const provider = new LiveStateYjsProvider(
      doc,
      "blk-removed-no-doc",
      () => seed,
      "removed",
      { fetchEndpoint, socketUrl: "ws://x/worktree" },
    );

    provider.connect();
    expect(docText(doc)).toBe(""); // may have a stored doc: wait

    // The subscription answers `null`: a POSITIVE "nothing stored" (the doc did
    // not survive — purged, or never opened). The seed is applied NOW, so the
    // restored block renders after one round trip — but not posted: the row is
    // still unconfirmed (FK gate).
    provider.onServerState(null);
    expect(docText(doc)).toBe("restored");
    expect(server).not.toHaveBeenCalled();

    // Confirmation lifts the gate: exactly one doc-init, and the seed was
    // ALREADY in the doc when it was posted.
    let textAtPost: string | null = null;
    server.mockImplementation(async ({ opts }) => {
      textAtPost = docText(doc);
      const body = (opts as unknown as { body: Blob }).body;
      const buf = await body.arrayBuffer();
      return { state: toBase64(new Uint8Array(buf)) };
    });
    provider.markBlockRowConfirmed();
    await flushMicrotasks();
    expect(server).toHaveBeenCalledTimes(1);
    expect(textAtPost).toBe("restored");
    expect(await postedBytes(0)).toEqual(seed);
    // The authoritative response (our own seed) merged as a no-op: one copy.
    expect(count(docText(doc), "restored")).toBe(1);
    expect(provider.isSynced).toBe(true);
    provider.destroy();
  });

  test("removed + the user typed before the null answer: the doc-init proposes the LOCAL doc, and the seed paragraph never lands beside the typing", async () => {
    const doc = new Y.Doc();
    const seed = encodedState(111, "restored");
    const provider = new LiveStateYjsProvider(
      doc,
      "blk-removed-typed",
      () => seed,
      "removed",
      { fetchEndpoint, socketUrl: "ws://x/worktree" },
    );
    provider.connect();
    expect(docText(doc)).toBe(""); // may have a stored doc: wait

    // The block rendered empty and the user typed into it during the round
    // trip. The doc now has a client, so the null answer must NOT pre-seed
    // (the seed would land beside the typing)…
    localEdit(doc, "typed");
    provider.onServerState(null);
    expect(docText(doc)).toBe("typed");

    // …and the doc-init the confirmation posts must propose what the doc
    // HOLDS, not `data.text`: the server creates the doc from the proposal
    // and answers with it, and that answer is merged back into this doc.
    const inits: Uint8Array[] = [];
    server.mockImplementation(async ({ endpoint, opts }) => {
      const body = (opts as unknown as { body: Blob }).body;
      const bytes = new Uint8Array(await body.arrayBuffer());
      if (endpoint === blockDocInit) {
        inits.push(bytes);
        return { state: toBase64(bytes) };
      }
      if (endpoint === blockDocUpdate) return undefined;
      throw new Error("unexpected endpoint");
    });
    provider.markBlockRowConfirmed();
    await flushMicrotasks();
    expect(inits).toHaveLength(1);
    const proposed = new Y.Doc();
    Y.applyUpdate(proposed, inits[0]!);
    expect(docText(proposed)).toBe("typed");
    // The queued local edit flushes once synced (a merge of bytes the doc-init
    // already carried — idempotent); let it drain before teardown.
    await runFlush();
    // One paragraph, the typed one; the row's "restored" seed is nowhere.
    expect(docText(doc)).toBe("typed");
    expect(count(docText(doc), "restored")).toBe(0);
    expect(provider.isSynced).toBe(true);
    provider.destroy();
  });
});
