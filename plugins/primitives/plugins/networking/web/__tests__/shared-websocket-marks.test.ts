/**
 * Every way into the shared socket's port handler is a marked task
 * (`primitives/perfs/task-marks`): LoAF names only "(anonymous)
 * (MessagePort.onmessage)", so the mark is what tells a frozen tab's stall
 * report which message — and which step or subscriber under it — it froze in.
 * Driven on the real tab client + worker host (`createTransportHub`).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  onTaskMark,
  runMarked,
} from "@plugins/primitives/plugins/perfs/plugins/task-marks/web";
import { SharedWebSocket } from "../shared-websocket";
import { subscribeNetDiag } from "../net-diag-bus";
import { subscribeWsStatus } from "../ws-status-bus";
import type { WorkerToTab } from "../shared-ws-protocol";
import { createTransportHub, type TabHandle } from "../testing";

const URL_PATH = "/ws/marks";

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("SharedWebSocket — task marks", () => {
  const built: SharedWebSocket[] = [];
  const cleanups: Array<() => void> = [];
  /** Every begun mark, `<source> <what>`, in order. */
  let begun: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    begun = [];
    cleanups.push(
      onTaskMark({
        begin: (source, describe) => {
          begun.push(`${source} ${describe().what}`);
          return begun.length;
        },
        end: () => {},
      }),
    );
  });

  afterEach(() => {
    for (const s of built.splice(0)) s.close();
    for (const c of cleanups.splice(0)) c();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function openTab(): Promise<{
    sws: SharedWebSocket;
    tab: TabHandle;
    hub: ReturnType<typeof createTransportHub>;
  }> {
    const hub = createTransportHub();
    const tab = hub.tab();
    const sws = new SharedWebSocket(URL_PATH, tab.hooks);
    built.push(sws);
    await flush();
    hub.server.all()[0]!.open();
    await flush();
    return { sws, tab, hub };
  }

  /** Deliver one worker message to the tab's live port, as the browser would. */
  function deliver(tab: TabHandle, msg: WorkerToTab): void {
    tab.ports.at(-1)!.onmessage!(new MessageEvent("message", { data: msg }));
  }

  test("status open: the arm, its onopen dispatch and each ws-status subscriber, named by the chain", async () => {
    const hub = createTransportHub();
    const tab = hub.tab();
    const sws = new SharedWebSocket(URL_PATH, tab.hooks);
    built.push(sws);
    sws.onopen = () =>
      runMarked(
        "live-state",
        () => ({ what: "open", detail: "" }),
        () => {},
      );
    cleanups.push(subscribeWsStatus(() => {}, "status-watcher"));
    cleanups.push(subscribeWsStatus(function namedFn() {}));
    await flush();
    begun = [];
    hub.server.all()[0]!.open();
    await flush();

    expect(begun).toContain(
      "networking port status open > ws-status open → status-watcher",
    );
    expect(begun).toContain(
      "networking port status open > ws-status open → namedFn",
    );
    expect(begun).toContain("networking port status open > onopen");
    expect(begun).toContain(
      "networking port status open > onopen > live-state:open",
    );
  });

  test("rx: the arm, with the consumer's own mark nested under it", async () => {
    const { sws, hub } = await openTab();
    sws.onmessage = () =>
      runMarked(
        "live-state",
        () => ({ what: "update a", detail: "" }),
        () => {},
      );
    begun = [];
    hub.server.all()[0]!.serverSend("frame");
    await flush();
    expect(begun).toEqual([
      "networking port rx",
      "networking port rx > live-state:update a",
      "networking port rx",
    ]);
  });

  test("diag: the arm names the event type, each net-diag subscriber its name", async () => {
    const { tab } = await openTab();
    cleanups.push(subscribeNetDiag(() => {}, "diag-watcher"));
    begun = [];
    deliver(tab, {
      kind: "diag",
      event: { type: "ws-close", url: "ws://x" },
    });
    expect(begun).toEqual([
      "networking port diag ws-close",
      "networking port diag ws-close > net-diag ws-close → diag-watcher",
      "networking port diag ws-close",
    ]);
  });

  test("ws-error: the arm and its onerror dispatch", async () => {
    const { sws, tab } = await openTab();
    sws.onerror = () => {};
    begun = [];
    deliver(tab, { kind: "ws-error" });
    expect(begun).toEqual([
      "networking port ws-error",
      "networking port ws-error > onerror",
      "networking port ws-error",
    ]);
  });

  test("released: the arm, its detach and its re-attach", async () => {
    const { tab } = await openTab();
    begun = [];
    deliver(tab, { kind: "released", attachedMs: 5 });
    expect(begun[0]).toBe("networking port released");
    expect(begun).toContain("networking port released > detach");
    expect(begun).toContain("networking port released > attach");
  });

  test("fatal: the arm is marked before it throws", async () => {
    const { tab } = await openTab();
    begun = [];
    expect(() => deliver(tab, { kind: "fatal", message: "boom" })).toThrow(
      "boom",
    );
    expect(begun[0]).toBe("networking port fatal");
  });
});
