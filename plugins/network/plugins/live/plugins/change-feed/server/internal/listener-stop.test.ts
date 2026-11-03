import { describe, expect, test } from "bun:test";
import type {
  DatabaseDriverImpl,
  ListenSession,
} from "@plugins/database/server";
import { createChangeFeedListener } from "./listener";
import type { FeedChange } from "./route-change";

// `stop()` while the session's open is still in flight (a boot shut down during
// its first connect, or mid-reconnect): stop finds no session to close, so the
// open's continuation must close what it gets — never install it and leave a
// LISTEN connection open after shutdown. Driven with a fake `listen` whose open
// the test resolves by hand; no database needed.

describe("stop() during an in-flight open", () => {
  test("the session the open resolves with is closed", async () => {
    let resolveOpen: (s: ListenSession) => void = () => {
      throw new Error("listen was never called");
    };
    let closed = 0;
    const listen: DatabaseDriverImpl["listen"] = () => {
      return new Promise((resolve) => {
        resolveOpen = resolve;
      });
    };
    const routed: FeedChange[] = [];
    const listener = createChangeFeedListener({
      listen,
      route: (change) => routed.push(change),
      coveredTables: () => [],
      // No timer may outlive the test.
      setIntervalFn: (() => 0) as unknown as typeof setInterval,
      clearIntervalFn: () => undefined,
    });

    listener.start();
    await listener.stop();
    resolveOpen({
      close: async () => {
        closed += 1;
      },
    });
    // Let the open's continuation run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closed).toBe(1);
    // A stopped listener never connected: nothing was swept or routed.
    expect(routed).toEqual([]);
  });
});
