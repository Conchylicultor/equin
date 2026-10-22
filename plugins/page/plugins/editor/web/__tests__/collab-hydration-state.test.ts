/**
 * The block-content session's HYDRATION STATE (stage 4 of
 * `research/2026-08-03-page-block-content-session-one-owner.md`).
 *
 * One property, four states, and each test below is a defect the machine
 * exists to close:
 *
 *  1. **A client-minted block never waits.** `maybeInit()` returns immediately
 *     while the row is unconfirmed, so anything that made a freshly-split block
 *     wait on the server here would cost it a full round trip and destroy the
 *     instant-split path. The locally-authoritative arm reaches `hydrated`
 *     inside one synchronous `connect()`, with no network at all.
 *  2. **An answer carrying nothing renderable is TRIVIALLY hydrated.** Yjs
 *     emits no event for an apply that integrates nothing, so `@lexical/yjs`
 *     never runs `syncYjsChangesToLexical` and NO commit is ever scheduled —
 *     waiting for one would strand every genuinely-empty block in `hydrating`
 *     forever, with its write path gated.
 *  3. **A verification mismatch is `stalled`, never a silent pass.** And the
 *     late (`promoteOnly`) probe may confirm agreement but must never conclude
 *     disagreement — a merely-pending commit looks exactly like a blind one.
 *  4. **`hydrating` gates the WRITE path**: the `data.text` projection does not
 *     persist and the transport does not flush. It does NOT gate the editing
 *     host (that would deadlock the caret authority), and the gate opens the
 *     moment teardown is decided, so an unmount always flushes.
 *  5. **A skeleton never paints over text the user has already seen.**
 *     `everRendered` is monotonic and owner-scoped precisely so it survives the
 *     two things that reset a session — recovery (a NEW session) and a Lexical
 *     remount — because those are exactly when the placeholder would otherwise
 *     reappear over a line the user was reading.
 *  6. **Recovery has two verbs, and using the wrong one is the reported bug.**
 *     `rehydrate()` re-attaches the binding and empties the editor on the way;
 *     `refetch()` re-reads the server into the live doc and moves nothing on
 *     screen. A doc that is merely behind the server gets the second one.
 *
 * Run with `bun run test:dom plugins/page/plugins/editor`.
 */

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";

const wsStatusListeners: Array<(ev: { status: string; url: string }) => void> =
  [];
// Spread the real module: the endpoints barrel calls `transportScoped` at load.
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

// The block's `blockDocs` row as `useLiveRow` hands it over: pending until the
// test delivers a stored state.
let rowValue:
  | { status: "loading"; refetch: () => Promise<void> }
  | {
      status: "ready";
      found: true;
      row: { state: string };
      refetch: () => Promise<void>;
    } = {
  status: "loading",
  refetch: () => Promise.resolve(),
};
vi.mock("@plugins/primitives/plugins/live-state/web", () => ({
  liveStateSocketKind: () => "worktree",
  liveStateSocketUrl: () => "ws://x/worktree",
}));
vi.mock("@plugins/network/plugins/live/web", () => ({
  useLiveRow: () => rowValue,
}));

import {
  fakeFetchEndpoint,
  withTransport,
  type FakeEndpointAnswer,
} from "@plugins/infra/plugins/endpoints/web/testing";
import { runsToXmlText, xmlTextContentLength, type RichText } from "../../core";
import type { BindingReplica } from "../internal/binding-replica";
import { CollabSession } from "../internal/collab-session";
import { blockDocsFor } from "../internal/use-block-docs";
import type {
  DocSourcedRuns,
  ProjectTextFn,
} from "../internal/doc-sourced-runs";
import { useCollabBlockDoc } from "../internal/use-collab-block-doc";

// The server's answers, scripted per case. The fake fetcher over it is what a
// directly-started owner is handed, and what `useCollabBlockDoc` reads from the
// rendered tree's transport (`withTransport(server)`).
const answer = vi.fn<FakeEndpointAnswer>();
const server = fakeFetchEndpoint(answer);
/** The registry the rendered hooks read, so a directly-started owner is theirs. */
const docs = blockDocsFor(server.transport);

/** A block's content doc as the wire carries it, built the way the app builds it. */
function docStateFor(runs: RichText): Uint8Array {
  const xml = runsToXmlText(runs);
  const doc = xml.doc;
  if (!doc)
    throw new Error("docStateFor: seed XmlText is not attached to a doc");
  return Y.encodeStateAsUpdate(doc);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The state an EMPTY block's doc row holds: a doc that renders nothing. */
const EMPTY_DOC_STATE = toBase64(Y.encodeStateAsUpdate(new Y.Doc()));

const buildSeedState = (): Uint8Array => docStateFor([{ text: "seed" }]);

let nextId = 0;
const blockId = (): string => `blk-hydration-${(nextId += 1)}`;

beforeEach(() => {
  vi.useFakeTimers();
  answer.mockReset();
  answer.mockResolvedValue({ state: EMPTY_DOC_STATE });
  rowValue = { status: "loading", refetch: () => Promise.resolve() };
});

afterEach(() => {
  vi.useRealTimers();
  wsStatusListeners.length = 0;
  vi.restoreAllMocks();
});

// --- 1. The client-minted arm ------------------------------------------------

test("a client-minted block reaches hydrated synchronously inside connect(), with no network", () => {
  const id = blockId();
  // `"unseen"` — a freshly split/inserted block, rendering from the optimistic
  // overlay before its `_blocks` row exists server-side; this client has never
  // seen the id in server truth, so nothing can be stored for it.
  const session = CollabSession.start(docs, id, buildSeedState, "unseen", true);
  expect(session.locallyAuthoritative).toBe(true);
  expect(session.state.kind).toBe("attaching");

  const replica = session.replicaForBinding();
  replica.connect();

  // Synchronously hydrated: this client IS the authority, so there is no remote
  // answer that could be missing and nothing to wait for.
  expect(session.state.kind).toBe("hydrated");
  expect(session.writeAllowed).toBe(true);
  expect(answer).not.toHaveBeenCalled();

  // …and the later confirmation is a RE-ASSERT: it must not walk the state
  // back, reset anything, or re-close the gate.
  session.owner.provider.markBlockRowConfirmed();
  expect(session.state.kind).toBe("hydrated");
  expect(session.writeAllowed).toBe(true);

  session.end();
  vi.advanceTimersByTime(1);
});

test("a re-created row (removed) is server-authoritative: hydrating until its surviving doc syncs", () => {
  const id = blockId();
  // `"removed"` — undo of a delete re-created the row optimistically. It is
  // unconfirmed like a split tail, but its stored doc SURVIVED the delete
  // (every delete is a trash), so the seed must NOT be applied and the arm is
  // the server's: wait for the subscription, exactly like an existing block.
  const session = CollabSession.start(
    docs,
    id,
    buildSeedState,
    "removed",
    true,
  );
  expect(session.locallyAuthoritative).toBe(false);
  const replica = session.replicaForBinding();
  replica.connect();
  expect(session.state.kind).toBe("hydrating");
  expect(session.writeAllowed).toBe(false);
  expect(answer).not.toHaveBeenCalled();

  // The surviving doc arrives; here it renders nothing, so the transport's own
  // sync announcement is the exit.
  session.owner.provider.onServerState(EMPTY_DOC_STATE);
  expect(session.state.kind).toBe("hydrated");
  expect(session.writeAllowed).toBe(true);
  expect(answer).not.toHaveBeenCalled();

  session.end();
  vi.advanceTimersByTime(1);
});

test("the in-memory transport is locally authoritative for its whole life", () => {
  const id = blockId();
  const session = CollabSession.start(
    docs,
    id,
    buildSeedState,
    "present",
    false,
  );
  expect(session.locallyAuthoritative).toBe(true);
  session.replicaForBinding().connect();
  expect(session.state.kind).toBe("hydrated");
  // A restart keeps the arm: with no server there is nothing to be behind, so
  // `stalled` stays structurally unreachable here.
  const successor = session.restart();
  expect(successor.locallyAuthoritative).toBe(true);
  vi.advanceTimersByTime(1);
  successor.end();
  vi.advanceTimersByTime(1);
});

// --- 2. An answer with nothing renderable ------------------------------------

test("an empty catch-up is trivially hydrated rather than waiting for a commit that never comes", () => {
  const id = blockId();
  const session = CollabSession.start(
    docs,
    id,
    buildSeedState,
    "present",
    true,
  );
  const replica = session.replicaForBinding();

  // Nothing delivered yet: the server's answer is still coming.
  replica.connect();
  expect(session.state.kind).toBe("hydrating");
  expect(session.writeAllowed).toBe(false);

  // The answer arrives and carries nothing the binding could render. Applying
  // it integrates NO content, so Yjs emits no update, `@lexical/yjs` never runs
  // and no commit is ever scheduled — this must resolve on the transport's own
  // sync announcement instead.
  session.owner.provider.onServerState(EMPTY_DOC_STATE);
  expect(session.state.kind).toBe("hydrated");
  expect(session.writeAllowed).toBe(true);

  session.end();
  vi.advanceTimersByTime(1);
});

test("an answer that DOES carry content stays hydrating until a commit proves it", () => {
  const id = blockId();
  const session = CollabSession.start(
    docs,
    id,
    buildSeedState,
    "present",
    true,
  );
  const replica = session.replicaForBinding();
  replica.connect();

  session.owner.provider.onServerState(
    toBase64(docStateFor([{ text: "hello" }])),
  );
  // Synced, but the replica now holds something: the binding has to prove it
  // rendered it, and the proof is the commit — not the sync.
  expect(session.state.kind).toBe("hydrating");

  const docLength = xmlTextContentLength(
    replica.replicaDoc.get("root", Y.XmlText) as Y.XmlText,
  );
  session.verifyRendered(docLength);
  expect(session.state.kind).toBe("hydrated");

  session.end();
  vi.advanceTimersByTime(1);
});

// --- 3. Verification ---------------------------------------------------------

test("a verification mismatch yields stalled, and a late probe may not conclude one", () => {
  const id = blockId();
  const session = CollabSession.start(
    docs,
    id,
    buildSeedState,
    "present",
    true,
  );
  const replica = session.replicaForBinding();
  session.owner.provider.onServerState(
    toBase64(docStateFor([{ text: "hello" }])),
  );
  replica.connect();
  expect(session.state.kind).toBe("hydrating");

  // The mount-time probe runs before the collab commit has landed, so "the
  // editor renders nothing" is the NORMAL state there. It may confirm, never
  // conclude.
  session.verifyRendered(0, true);
  expect(session.state.kind).toBe("hydrating");

  // The real commit: the binding rendered nothing of what its replica holds.
  session.verifyRendered(0);
  expect(session.state).toMatchObject({
    kind: "stalled",
    reason: "binding-behind-replica",
    shownLength: 0,
  });
  const stalled = session.state;
  if (stalled.kind !== "stalled") throw new Error("unreachable");
  expect(stalled.docLength).toBeGreaterThan(0);
  // A failure must not hold the user's bytes hostage — it gets a Retry instead.
  expect(session.writeAllowed).toBe(true);

  session.end();
  vi.advanceTimersByTime(1);
});

// --- 4. The write gate -------------------------------------------------------

test("hydrating holds the transport flush, and ending it releases the bytes", async () => {
  const id = blockId();
  const session = CollabSession.start(
    docs,
    id,
    buildSeedState,
    "present",
    true,
  );
  const replica = session.replicaForBinding();
  replica.connect();
  // Sync WITH content, so the session stays hydrating (no commit can arrive:
  // there is no real Lexical binding here).
  session.owner.provider.onServerState(
    toBase64(docStateFor([{ text: "hello" }])),
  );
  expect(session.state.kind).toBe("hydrating");

  // A local edit while the gate is closed: queued, never posted.
  answer.mockClear();
  replica.replicaDoc.transact(() => {
    const root = replica.replicaDoc.get("root", Y.XmlText);
    root.insert(root.length, "!");
  }, "binding");
  await vi.advanceTimersByTimeAsync(500);
  expect(answer).not.toHaveBeenCalled();
  // …but the cloud still says the bytes are owed.
  expect(session.owner.provider.getSaveState().phase).toBe("syncing");

  // Teardown opens the gate the moment it is DECIDED, so the eager disconnect
  // flush is never swallowed.
  session.end();
  await vi.advanceTimersByTimeAsync(5);
  expect(answer).toHaveBeenCalled();
});

test("hydrating suppresses the data.text projection, and opening the gate replays it", async () => {
  const id = blockId();
  const projectText = vi.fn();
  const { result, unmount } = renderHook(
    () =>
      useCollabBlockDoc(
        id,
        [],
        "present",
        projectText as unknown as ProjectTextFn,
      ),
    { wrapper: withTransport(server) },
  );

  // Mount the binding the way `CollaborationPlugin` does.
  let replica!: BindingReplica;
  act(() => {
    replica = result.current.providerFactory(id, new Map()) as BindingReplica;
    replica.connect();
  });
  expect(result.current.hydration.kind).toBe("hydrating");

  // Content lands in this block's doc (another binding, offscreen surgery, a
  // server push) — the projection arms and its window expires while the gate is
  // still closed.
  act(() => {
    Y.applyUpdate(
      replica.replicaDoc,
      docStateFor([{ text: "hello" }]),
      "binding",
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(projectText).not.toHaveBeenCalled();

  // Proving the binding renders what its replica holds opens the gate, and the
  // dropped window is replayed push-based — not on the next keystroke.
  const shown = xmlTextContentLength(
    replica.replicaDoc.get("root", Y.XmlText) as Y.XmlText,
  );
  act(() => {
    result.current.verifyRendered(shown);
  });
  expect(result.current.hydration.kind).toBe("hydrated");
  expect(projectText).toHaveBeenCalledTimes(1);
  expect(projectText.mock.calls[0]?.[1] as DocSourcedRuns).toEqual([
    { text: "hello" },
  ]);

  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5);
  });
});

// --- 5. "Was shown" — the monotonic latch (F4) --------------------------------
//
// `everRendered` answers a strictly weaker question than the hydration state:
// not "does what is on screen agree with the doc right now", but "has this
// block's text ever been on screen at all". It exists so a loading state is
// never painted over something the user was reading — which is why it lives on
// the OWNER and is never cleared. See `collab-session.ts`.

test("a genuinely empty block never latches everRendered", () => {
  const id = blockId();
  const session = CollabSession.start(
    docs,
    id,
    buildSeedState,
    "present",
    true,
  );
  session.replicaForBinding().connect();
  session.owner.provider.onServerState(EMPTY_DOC_STATE);

  // Hydrated, and nothing was ever shown — so the placeholder's decision for
  // this block still rests entirely on the row, as it must.
  expect(session.state.kind).toBe("hydrated");
  expect(session.everRendered).toBe(false);

  // A commit rendering nothing is not "was shown" either.
  session.verifyRendered(0);
  expect(session.everRendered).toBe(false);

  session.end();
  vi.advanceTimersByTime(1);
});

test("the first commit carrying text latches it, and every later window inherits it", () => {
  const id = blockId();
  const session = CollabSession.start(
    docs,
    id,
    buildSeedState,
    "present",
    true,
  );
  const replica = session.replicaForBinding();
  replica.connect();
  session.owner.provider.onServerState(
    toBase64(docStateFor([{ text: "hello" }])),
  );
  expect(session.everRendered).toBe(false);

  const docLength = xmlTextContentLength(
    replica.replicaDoc.get("root", Y.XmlText) as Y.XmlText,
  );
  session.verifyRendered(docLength);
  expect(session.state.kind).toBe("hydrated");
  expect(session.everRendered).toBe(true);

  // THE transition the latch exists to survive: recovery mints a NEW session,
  // whose own state walks back to `attaching`. The block's text was still on
  // screen a moment ago, so the successor must not invite a skeleton over it.
  const successor = session.restart();
  expect(successor.state.kind).toBe("attaching");
  expect(successor.everRendered).toBe(true);

  // …and it stays true through the successor's whole unproven window.
  successor.replicaForBinding().connect();
  expect(successor.state.kind).toBe("hydrating");
  expect(successor.everRendered).toBe(true);

  vi.advanceTimersByTime(1);
  successor.end();
  vi.advanceTimersByTime(1);
});

test("even a probe that may not conclude agreement still latches what it saw", () => {
  const id = blockId();
  const session = CollabSession.start(
    docs,
    id,
    buildSeedState,
    "present",
    true,
  );
  const replica = session.replicaForBinding();
  session.owner.provider.onServerState(
    toBase64(docStateFor([{ text: "hello" }])),
  );
  replica.connect();

  // The late mount-time probe: it may confirm, never conclude disagreement —
  // but it DID observe a non-empty line, and that observation is the latch's
  // whole subject.
  session.verifyRendered(3, true);
  expect(session.state.kind).toBe("hydrating");
  expect(session.everRendered).toBe(true);

  session.end();
  vi.advanceTimersByTime(1);
});

test("the flip reaches the session's own state listeners", () => {
  const id = blockId();
  const session = CollabSession.start(
    docs,
    id,
    buildSeedState,
    "present",
    true,
  );
  session.replicaForBinding().connect();
  session.owner.provider.onServerState(EMPTY_DOC_STATE);

  const notified = vi.fn();
  const unsubscribe = session.subscribeState(notified);
  // The state cannot move (already `hydrated`), so anything this listener hears
  // is the latch — which is exactly what a consumer's snapshot needs.
  session.verifyRendered(4);
  expect(session.everRendered).toBe(true);
  expect(notified).toHaveBeenCalled();

  unsubscribe();
  session.end();
  vi.advanceTimersByTime(1);
});

// --- 6. The two recovery verbs (F3) ------------------------------------------
//
// `rehydrate()` ends the session and mints a fresh EMPTY replica — the only
// cure for a binding that missed its post-attach events, and pure damage for a
// doc that is merely behind the server. `refetch()` is the other half on its
// own: an authoritative re-read into the live doc, with the replica, the
// session and everything on screen untouched.

test("refetch() re-reads the server without dropping the session or re-attaching the binding", async () => {
  const id = blockId();
  const projectText = vi.fn();
  const { result, rerender, unmount } = renderHook(
    () =>
      useCollabBlockDoc(
        id,
        [],
        "present",
        projectText as unknown as ProjectTextFn,
      ),
    { wrapper: withTransport(server) },
  );

  let replica!: BindingReplica;
  act(() => {
    replica = result.current.providerFactory(id, new Map()) as BindingReplica;
    replica.connect();
  });

  // The honest witness, before anything answered: an empty doc here proves
  // NOTHING, which is what keeps the starvation arm from firing on a healthy
  // cold open (the 572 false positives).
  expect(result.current.isSynced()).toBe(false);

  act(() => {
    rowValue = {
      status: "ready",
      found: true,
      row: { state: toBase64(docStateFor([{ text: "hello" }])) },
      refetch: () => Promise.resolve(),
    };
    rerender();
  });
  expect(result.current.isSynced()).toBe(true);

  const shown = xmlTextContentLength(
    replica.replicaDoc.get("root", Y.XmlText) as Y.XmlText,
  );
  act(() => {
    result.current.verifyRendered(shown);
  });
  expect(result.current.hydration.kind).toBe("hydrated");
  expect(result.current.everRendered).toBe(true);

  const generationBefore = result.current.attachGeneration;
  answer.mockClear();
  await act(async () => {
    result.current.refetch();
    await vi.advanceTimersByTimeAsync(5);
  });

  // A re-read was requested…
  expect(answer).toHaveBeenCalled();
  // …and NOTHING on screen moved: same binding (no re-attach key bump), same
  // replica, same proven session. This is the whole difference between a cure
  // and the symptom the user reported.
  expect(result.current.attachGeneration).toBe(generationBefore);
  expect(replica.isDestroyed).toBe(false);
  expect(result.current.hydration.kind).toBe("hydrated");

  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5);
  });
});

test("rehydrate() DOES re-attach — and the everRendered latch survives it", async () => {
  const id = blockId();
  const projectText = vi.fn();
  const { result, rerender, unmount } = renderHook(
    () =>
      useCollabBlockDoc(
        id,
        [],
        "present",
        projectText as unknown as ProjectTextFn,
      ),
    { wrapper: withTransport(server) },
  );

  let replica!: BindingReplica;
  act(() => {
    replica = result.current.providerFactory(id, new Map()) as BindingReplica;
    replica.connect();
  });
  act(() => {
    rowValue = {
      status: "ready",
      found: true,
      row: { state: toBase64(docStateFor([{ text: "hello" }])) },
      refetch: () => Promise.resolve(),
    };
    rerender();
  });
  const shown = xmlTextContentLength(
    replica.replicaDoc.get("root", Y.XmlText) as Y.XmlText,
  );
  act(() => {
    result.current.verifyRendered(shown);
  });
  expect(result.current.everRendered).toBe(true);

  act(() => {
    result.current.rehydrate();
  });

  // The destructive verb, doing exactly what it says: a bumped key (Lexical
  // re-attaches) over a brand-new session that has proven nothing yet.
  expect(result.current.attachGeneration).toBe(1);
  expect(result.current.hydration.kind).not.toBe("hydrated");
  // F4: the block's text WAS on screen, so no skeleton may paint here — even
  // though this session cannot prove anything about it.
  expect(result.current.everRendered).toBe(true);

  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5);
  });
});
