/**
 * The module-level tx-ack registry (`web/tx-ack-registry.ts`) — the client half
 * of the mutation-ack channel. Pins: per-(key, paramsKey) namespacing (a wrong-
 * tuple confirmation is impossible in either direction), the insertion-order
 * ring bound (oldest acks age out past ACK_RING_CAP — safe, the watermark
 * backstop confirms), and emit-after-note (a subscriber reading
 * `hasResourceTxAck` synchronously inside its callback already sees the
 * freshly-noted acks).
 *
 * The registry is module-level and never cleared (that is the point — the
 * optimistic hook reads it without a NotificationsProvider), so every test uses
 * its own resource key.
 */

import { describe, expect, test } from "vitest";
import {
  hasResourceTxAck,
  noteResourceTxAcks,
  subscribeResourceTxAcks,
} from "../tx-ack-registry";

// Keep in sync with the ACK_RING_CAP literal in tx-ack-registry.ts.
const ACK_RING_CAP = 256;

describe("tx-ack registry", () => {
  test("notes then answers membership; unknown txids and never-noted tuples are false", () => {
    noteResourceTxAcks("reg-a", {}, ["100", "101"]);
    expect(hasResourceTxAck("reg-a", {}, "100")).toBe(true);
    expect(hasResourceTxAck("reg-a", {}, "101")).toBe(true);
    expect(hasResourceTxAck("reg-a", {}, "102")).toBe(false);
    expect(hasResourceTxAck("reg-never", {}, "100")).toBe(false);
  });

  test("per-tuple namespacing: the same txid acked for one params tuple is invisible to another", () => {
    noteResourceTxAcks("reg-ns", { id: "c1" }, ["200"]);
    expect(hasResourceTxAck("reg-ns", { id: "c1" }, "200")).toBe(true);
    expect(hasResourceTxAck("reg-ns", { id: "c2" }, "200")).toBe(false);
    expect(hasResourceTxAck("reg-ns", undefined, "200")).toBe(false);
    // …and params serialization is key-order-insensitive (sorted-key JSON).
    noteResourceTxAcks("reg-ns", { b: "2", a: "1" }, ["201"]);
    expect(hasResourceTxAck("reg-ns", { a: "1", b: "2" }, "201")).toBe(true);
  });

  test("undefined params and {} name the same tuple (the param-less resource)", () => {
    noteResourceTxAcks("reg-empty", undefined, ["300"]);
    expect(hasResourceTxAck("reg-empty", {}, "300")).toBe(true);
  });

  test("the ring is bounded: past ACK_RING_CAP the oldest acks age out, newest survive", () => {
    const txids = Array.from({ length: ACK_RING_CAP + 1 }, (_, i) => `${1000 + i}`);
    noteResourceTxAcks("reg-ring", {}, txids);
    expect(hasResourceTxAck("reg-ring", {}, "1000")).toBe(false); // evicted
    expect(hasResourceTxAck("reg-ring", {}, "1001")).toBe(true); // oldest survivor
    expect(hasResourceTxAck("reg-ring", {}, `${1000 + ACK_RING_CAP}`)).toBe(true);
  });

  test("duplicate notes are no-ops (they neither grow the ring nor re-order eviction)", () => {
    noteResourceTxAcks("reg-dup", {}, ["400"]);
    noteResourceTxAcks("reg-dup", {}, ["400", "400"]);
    // Fill to exactly the cap counting the one existing entry — nothing evicts.
    const rest = Array.from({ length: ACK_RING_CAP - 1 }, (_, i) => `${2000 + i}`);
    noteResourceTxAcks("reg-dup", {}, rest);
    expect(hasResourceTxAck("reg-dup", {}, "400")).toBe(true);
  });

  test("emit-after-note: subscribers fire after the acks are readable, with the noted (key, params)", () => {
    const seen: Array<{ key: string; params: unknown; visible: boolean }> = [];
    const unsubscribe = subscribeResourceTxAcks((key, params) => {
      seen.push({ key, params, visible: hasResourceTxAck(key, params, "500") });
    });
    noteResourceTxAcks("reg-emit", { id: "x" }, ["500"]);
    expect(seen).toEqual([{ key: "reg-emit", params: { id: "x" }, visible: true }]);

    unsubscribe();
    noteResourceTxAcks("reg-emit", { id: "x" }, ["501"]);
    expect(seen).toHaveLength(1); // unsubscribed — no further fires
  });

  test("an empty txid list neither notes nor emits", () => {
    let fires = 0;
    const unsubscribe = subscribeResourceTxAcks(() => {
      fires++;
    });
    noteResourceTxAcks("reg-noop", {}, []);
    expect(fires).toBe(0);
    unsubscribe();
  });
});
