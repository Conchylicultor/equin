import { describe, expect, test } from "bun:test";
import { withHostServices } from "@plugins/framework/plugins/server-core/core/testing";
import {
  TranscriptSource,
  type TranscriptSnapshot,
} from "@plugins/conversations/plugins/transcript-source/server";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { derivedFromEvents } from "./conversation-events";

const at = "2026-11-06T00:00:00.000Z";
const text = (t: string): JsonlEvent => ({ kind: "system", at, text: t });

/** A transcript source whose watch is driven by hand. */
function fakeSource() {
  const listeners = new Set<(s: TranscriptSnapshot) => void>();
  let n = 0;
  const provider = TranscriptSource.provide({
    signature: () => Promise.resolve(String(n)),
    events: () => Promise.resolve([]),
    watch: (_id, onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    image: () => {
      throw new Error("no images");
    },
  });
  const write = (events: JsonlEvent[]) => {
    n += 1;
    for (const l of listeners) l({ events, signature: String(n) });
  };
  return { provider, write };
}

describe("derivedFromEvents", () => {
  // The texts of the first `before` events: what a fold.before reads.
  const prefix = derivedFromEvents(
    ({ id, before }: { id: string; before: number }) => `${id}:${before}`,
    ({ before }, events) => events.slice(0, before).map((e) => e.at + e.kind),
  );

  test("an append past the prefix notifies nothing; a rewrite inside it does", async () => {
    const { provider, write } = fakeSource();
    await withHostServices([provider], () => {
      const params = { id: "c", before: 2 };
      let notified = 0;
      const stop = prefix.watch(params, () => (notified += 1));
      // Nothing served yet: every change notifies.
      write([text("a")]);
      expect(notified).toBe(1);
      const served = prefix.load(params, [text("a"), text("b")]);
      write([text("a"), text("b"), text("c")]);
      write([text("a"), text("b"), text("c"), text("d")]);
      expect(notified).toBe(1);
      // An equal value is the object last served.
      expect(prefix.load(params, [text("a"), text("b"), text("x")])).toBe(
        served,
      );
      // A rewind drops an event inside the prefix.
      write([text("a")]);
      expect(notified).toBe(2);
      stop();
      write([text("a"), text("b")]);
      expect(notified).toBe(2);
    });
  });
});
