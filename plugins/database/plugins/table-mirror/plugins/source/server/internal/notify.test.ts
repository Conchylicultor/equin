import { describe, expect, test } from "bun:test";
import type { ListenHandlers } from "@plugins/database/server";
import { createMirrorLogNotifier } from "./notify";
import { MIRROR_LOG_CHANNEL } from "./triggers";

/** A host whose LISTEN sessions the test drives: notify, lose, count opens and closes. */
// A failed open is not covered: it is rethrown as an unhandled rejection by
// design (loud), which bun:test fails the run on.
function fakeHost(setIds: readonly string[] = ["a", "b"]) {
  const sessions: { handlers: ListenHandlers; closed: boolean }[] = [];
  const host = {
    listen: (channels: readonly string[], handlers: ListenHandlers) => {
      expect(channels).toEqual([MIRROR_LOG_CHANNEL]);
      const s = { handlers, closed: false };
      sessions.push(s);
      return Promise.resolve({
        close: () => {
          s.closed = true;
          return Promise.resolve();
        },
      });
    },
    setIds: () => setIds,
  };
  return {
    host,
    sessions,
    latest: () => sessions.at(-1)!,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createMirrorLogNotifier", () => {
  test("one session for every subscriber; each notice reaches all of them", async () => {
    const h = fakeHost();
    const n = createMirrorLogNotifier(h.host);
    const one: string[] = [];
    const two: string[] = [];
    const off1 = await n.subscribe((s) => one.push(s));
    const off2 = await n.subscribe((s) => two.push(s));
    expect(h.sessions).toHaveLength(1);
    h.latest().handlers.notification(MIRROR_LOG_CHANNEL, "a");
    expect(one).toEqual(["a"]);
    expect(two).toEqual(["a"]);
    off1();
    expect(h.latest().closed).toBe(false);
    off2();
    await tick();
    expect(h.latest().closed).toBe(true);
  });

  test("a lost session is reopened, then every set is re-signalled", async () => {
    const h = fakeHost(["a", "b"]);
    const n = createMirrorLogNotifier(h.host);
    const got: string[] = [];
    const off = await n.subscribe((s) => got.push(s));
    h.latest().handlers.lost(new Error("connection reset"));
    expect(h.sessions).toHaveLength(2);
    await tick();
    expect(got).toEqual(["a", "b"]);
    h.latest().handlers.notification(MIRROR_LOG_CHANNEL, "b");
    expect(got).toEqual(["a", "b", "b"]);
    off();
    await tick();
    expect(h.latest().closed).toBe(true);
  });

  test("a session lost with nobody subscribed is not reopened", async () => {
    const h = fakeHost();
    const n = createMirrorLogNotifier(h.host);
    const off = await n.subscribe(() => {});
    off();
    h.sessions[0]!.handlers.lost(new Error("gone"));
    expect(h.sessions).toHaveLength(1);
  });
});
