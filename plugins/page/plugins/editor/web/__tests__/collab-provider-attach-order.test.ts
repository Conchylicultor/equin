import { describe, expect, it } from "vitest";
import { Doc, applyUpdate, encodeStateAsUpdate, XmlText } from "yjs";
import { LiveStateYjsProvider } from "../internal/live-state-yjs-provider";
import { fakeFetchEndpoint } from "@plugins/infra/plugins/endpoints/web/testing";

// Every case binds an existing block to a delivered state: nothing here may
// reach the server, so any endpoint call fails the case loudly.
const { fetchEndpoint } = fakeFetchEndpoint((call) => {
  throw new Error(`unexpected endpoint call: ${call.route}`);
});

/**
 * THE binding-attach-order invariant of the content-doc transport.
 *
 * `@lexical/yjs` ingests a block's `Y.Doc` EXCLUSIVELY through the `observeDeep`
 * events its binding registers when it mounts — `createBinding` starts from an
 * empty CollabElementNode and never reads a doc that already holds content, and
 * `shouldBootstrap` is false. So server bytes applied to the doc BEFORE the
 * binding attaches are invisible to the editor forever: `lastAppliedState` makes
 * the re-apply a no-op and Yjs emits no event for state it already holds.
 *
 * `CollaborationPlugin` calls `connect()` only after registering that observer,
 * so `connect()` is the earliest safe apply point — and a value delivered before
 * it must be HELD, not applied. That is exactly the warm-navigation path (a
 * cached `page-block-doc` settles on the first render, before the binding
 * exists), which rendered every block's text empty until a reload.
 */

/** The bytes a stored content doc would ship, base64 as the wire carries them. */
function storedState(text: string): string {
  const doc = new Doc();
  (doc.get("root", XmlText) as XmlText).insert(0, text);
  const bytes = encodeStateAsUpdate(doc);
  return btoa(String.fromCharCode(...bytes));
}

/** Stand in for the Lexical binding: what it would see once it starts observing. */
function attachBinding(doc: Doc): { updates: number } {
  const seen = { updates: 0 };
  doc.on("update", () => {
    seen.updates += 1;
  });
  return seen;
}

describe("LiveStateYjsProvider — server state reaches the binding", () => {
  it("holds a pre-connect server state and applies it on connect()", () => {
    const doc = new Doc();
    const provider = new LiveStateYjsProvider(
      doc,
      "block-1",
      () => new Uint8Array(),
      "present",
      { fetchEndpoint, socketUrl: "ws://x/worktree" },
    );

    // Warm nav: the subscription is already settled, so the owning hook's effect
    // delivers the value BEFORE CollaborationPlugin has built its binding.
    provider.onServerState(storedState("hello"));

    // The binding mounts and starts observing — it has seen nothing yet.
    const binding = attachBinding(doc);
    expect(binding.updates).toBe(0);

    provider.connect();

    // The held state lands as a real Yjs update the binding observes.
    expect(binding.updates).toBe(1);
    expect((doc.get("root", XmlText) as XmlText).toString()).toContain("hello");
    provider.destroy();
  });

  it("applies a post-connect push straight through (the cold path)", () => {
    const doc = new Doc();
    const provider = new LiveStateYjsProvider(
      doc,
      "block-2",
      () => new Uint8Array(),
      "present",
      { fetchEndpoint, socketUrl: "ws://x/worktree" },
    );
    const binding = attachBinding(doc);

    provider.connect(); // subscription still pending — nothing to apply
    expect(binding.updates).toBe(0);

    provider.onServerState(storedState("world"));
    expect(binding.updates).toBe(1);
    expect((doc.get("root", XmlText) as XmlText).toString()).toContain("world");
    provider.destroy();
  });

  it("never double-applies the same state (idempotent re-delivery)", () => {
    const doc = new Doc();
    const provider = new LiveStateYjsProvider(
      doc,
      "block-3",
      () => new Uint8Array(),
      "present",
      { fetchEndpoint, socketUrl: "ws://x/worktree" },
    );
    const state = storedState("once");
    provider.onServerState(state);
    const binding = attachBinding(doc);
    provider.connect();
    provider.onServerState(state); // an echo of the value already applied

    expect(binding.updates).toBe(1);
    expect((doc.get("root", XmlText) as XmlText).toString()).toContain("once");
    provider.destroy();
  });

  it("pre-applies the data.text seed for an unconfirmed (client-minted) block", () => {
    const doc = new Doc();
    const seedDoc = new Doc();
    (seedDoc.get("root", XmlText) as XmlText).insert(0, "split-tail");
    const seed = encodeStateAsUpdate(seedDoc);

    // "unseen": this client has never seen the id in server truth ⇒ nothing can be stored for it,
    // so the seed hydrates the editor instantly at connect().
    const provider = new LiveStateYjsProvider(
      doc,
      "block-4",
      () => seed,
      "unseen",
      { fetchEndpoint, socketUrl: "ws://x/worktree" },
    );
    const binding = attachBinding(doc);
    provider.connect();

    expect(binding.updates).toBe(1);
    expect((doc.get("root", XmlText) as XmlText).toString()).toContain(
      "split-tail",
    );
    provider.destroy();
  });

  it("a doc that received bytes with no binding attached would strand them (why the hold exists)", () => {
    // The failure this guards against, spelled out: apply first, observe second,
    // and the observer never learns the content exists. Re-delivering the very
    // same state cannot heal it — Yjs emits nothing for a state the doc already
    // holds, which is why the apply must be ordered AFTER the binding attaches
    // rather than merely repeated.
    const bytes = base64ToBytes(storedState("stranded"));
    const doc = new Doc();
    applyUpdate(doc, bytes, "server");
    const binding = attachBinding(doc);
    applyUpdate(doc, bytes, "server");

    expect((doc.get("root", XmlText) as XmlText).toString()).toContain(
      "stranded",
    );
    expect(binding.updates).toBe(0); // ← the editor renders empty forever
  });
});

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
