/**
 * Lifetime tests for the block-content session + owner (`collab-session.ts`).
 * Three properties, each a defect the object exists to close:
 *
 *  1. **Teardown retention** — the deferred end must RETAIN an owner whose
 *     provider still holds buffered (unflushed) local edits (an ordinary
 *     unmount coinciding with a transient outage), and only truly destroy it
 *     once a reconnect drains the queue, push-based via the provider's
 *     teardown-ready signal.
 *  2. **Release by identity** — a spent session can never decrement the owner
 *     that REPLACED the one it held. Releasing by block id (what the registry
 *     used to do) would leak the dead owner and prematurely destroy the live
 *     one.
 *  3. **A live binding's replica is never destroyed under it** — a `restart()`
 *     (the recovery verb behind `rehydrate()`) racing an unmount used to be
 *     able to destroy a replica whose binding was still mounted, relaying that
 *     binding's last edits nowhere, silently.
 *
 * Run with `bun run test:dom plugins/page/plugins/editor`.
 */

import { afterEach, beforeEach, expect, test, vi } from "vitest";
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

vi.mock("@plugins/primitives/plugins/live-state/web", () => ({
  liveStateSocketKind: () => "worktree",
}));
vi.mock("@plugins/network/plugins/live/web", () => ({
  useLiveRow: vi.fn(() => ({
    status: "loading",
    refetch: () => Promise.resolve(),
  })),
}));

import {
  fakeFetchEndpoint,
  type FakeEndpointAnswer,
} from "@plugins/infra/plugins/endpoints/web/testing";
import {
  BlockDocs,
  blockDocOwnerOf,
  CollabSession,
} from "../internal/collab-session";

// The owners' endpoint client, handed in at `start` (the editor's transport): a
// plain test double, so each case scripts its server.
const server = vi.fn<FakeEndpointAnswer>();
const { fetchEndpoint } = fakeFetchEndpoint(server);
/** The owners' registry: its server is the double, its socket the one the bus reopens. */
const docs = new BlockDocs({ fetchEndpoint, socketUrl: "ws://x/worktree" });

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

function flushMicrotasks(): Promise<void> {
  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {});
}

const buildSeedState = () => encodedState(111, "seed");

beforeEach(() => {
  vi.useFakeTimers();
  server.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  wsStatusListeners.length = 0;
  vi.restoreAllMocks();
});

test("deferred end retains an owner with buffered edits and finalizes after the queue drains", async () => {
  const blockId = "blk-session-teardown";

  const session = CollabSession.start(
    docs,
    blockId,
    buildSeedState,
    "present",
    true,
  );
  const owner = session.owner;
  await owner.provider.connect();
  owner.provider.onServerState(toBase64(encodedState(222, "stored")));
  await flushMicrotasks();

  // A local edit whose flush fails at the network level (transient outage).
  server.mockRejectedValueOnce(new TypeError("network down"));
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  owner.doc.transact(() => {
    const root = owner.doc.get("root", Y.XmlText);
    root.insert(root.length, " last words");
  }, "binding");
  await vi.advanceTimersByTimeAsync(400); // flush debounce → failed POST
  await flushMicrotasks();
  expect(warnSpy).toHaveBeenCalled();

  // Ordinary unmount: end the only session; the retention window expires.
  session.end();
  await vi.advanceTimersByTimeAsync(1);
  await flushMicrotasks();

  // RETAINED: a new session over the block gets the SAME owner (nothing was
  // destroyed while unflushed bytes remained).
  const reopened = CollabSession.start(
    docs,
    blockId,
    buildSeedState,
    "present",
    true,
  );
  expect(reopened.owner).toBe(owner);
  reopened.end();
  await vi.advanceTimersByTimeAsync(1);

  // The tab reconnects; the retained provider drains its queue…
  server.mockResolvedValue(undefined);
  for (const cb of [...wsStatusListeners])
    cb({ status: "open", url: "ws://x/worktree" });
  await flushMicrotasks();

  // …and the owner is finalized push-based: a fresh session now mints a NEW
  // owner (the old one was destroyed once safe).
  const fresh = CollabSession.start(
    docs,
    blockId,
    buildSeedState,
    "present",
    true,
  );
  expect(fresh.owner).not.toBe(owner);
  fresh.end();
  await vi.advanceTimersByTimeAsync(1);
  await flushMicrotasks();
});

test("a spent session's end never decrements the owner that replaced it", async () => {
  // The by-id release hazard: `releaseCollabDoc(blockId)` decremented whichever
  // entry sat at that id, so a stale hold releasing after the entry had been
  // replaced destroyed the LIVE one (and leaked the dead one). A session holds
  // the owner reference, so there is no id left to resolve wrongly.
  const blockId = "blk-session-identity";

  const first = CollabSession.start(
    docs,
    blockId,
    buildSeedState,
    "present",
    false,
  );
  const firstOwner = first.owner;
  first.end();
  await vi.advanceTimersByTimeAsync(1);
  // Nothing buffered on the local transport, so the owner really is gone.
  expect(blockDocOwnerOf(docs, blockId)).toBeNull();
  expect(firstOwner.doc.isDestroyed).toBe(true);

  // A second editor opens the same block: a genuinely different owner.
  const second = CollabSession.start(
    docs,
    blockId,
    buildSeedState,
    "present",
    false,
  );
  expect(second.owner).not.toBe(firstOwner);

  // The stale session tears down again (a late cleanup, a double release).
  first.end();
  await vi.advanceTimersByTimeAsync(1);
  await flushMicrotasks();

  // The LIVE owner is untouched: still registered, still usable.
  expect(blockDocOwnerOf(docs, blockId)).toBe(second.owner);
  expect(second.owner.doc.isDestroyed).toBe(false);
  second.owner.doc.transact(() => {
    second.owner.doc.get("root", Y.XmlText).insert(0, "alive");
  }, "binding");
  expect(second.owner.doc.get("root", Y.XmlText).toString()).toBe("alive");

  second.end();
  await vi.advanceTimersByTimeAsync(1);
});

test("a restart racing an unmount never destroys a replica whose binding is still mounted", async () => {
  // `rehydrate()` ends the session and starts its successor. If the retention
  // window expires before React has processed the remount, the OUTGOING
  // binding is still attached to the outgoing replica — destroying it would
  // strand that binding's last keystrokes (BindingReplica.disconnect() after
  // destroy() is guarded and silent, so the loss would be invisible).
  const blockId = "blk-session-restart-race";

  const session = CollabSession.start(
    docs,
    blockId,
    buildSeedState,
    "present",
    false,
  );
  const replica = session.replicaForBinding();
  replica.connect(); // the binding attached and connected

  const successor = session.restart();
  expect(successor.owner).toBe(session.owner); // the block's owner survives
  expect(blockDocOwnerOf(docs, blockId)).toBe(successor.owner);

  await vi.advanceTimersByTimeAsync(1); // retention window expires…

  // …and the still-connected replica is NOT destroyed: its binding still
  // relays through it, all the way into the canonical doc.
  expect(replica.replicaDoc.isDestroyed).toBe(false);
  replica.replicaDoc.transact(() => {
    const root = replica.replicaDoc.get("root", Y.XmlText);
    root.insert(root.length, "!tail");
  }, "binding");
  expect(session.owner.doc.get("root", Y.XmlText).toString()).toContain(
    "!tail",
  );

  // The outgoing binding finally unmounts: the end finishes push-based, on the
  // disconnect itself — never on a second timer.
  replica.disconnect();
  expect(replica.replicaDoc.isDestroyed).toBe(true);
  // The successor is unaffected and still owns the block.
  expect(blockDocOwnerOf(docs, blockId)).toBe(successor.owner);
  expect(successor.owner.doc.isDestroyed).toBe(false);

  successor.end();
  await vi.advanceTimersByTimeAsync(1);
});
