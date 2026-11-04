import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFeedCut } from "./cut";

// A cut whose barrier deadline passes while its own NOTIFY is still pending
// (a starved pool, a slow host) is refused to its caller — never an unhandled
// rejection (the 2026-11-04 `server-unhandled` report: "its barrier did not
// arrive within 1500 ms").

let unhandled: unknown[];
const onUnhandled = (err: unknown) => {
  unhandled.push(err);
};

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("feedCut", () => {
  test("a deadline passing while the NOTIFY is pending rejects the cut, not the process", async () => {
    const cut = createFeedCut({
      watermark: () => Promise.resolve("42"),
      barrier: (_token, deadlineMs) =>
        delay(deadlineMs).then(() => {
          throw new Error("feed cut failed: its barrier did not arrive");
        }),
      notify: () => delay(50),
      deadlineMs: 5,
    });
    expect(cut()).rejects.toThrow("its barrier did not arrive");
    // Past the NOTIFY too, so a leaked rejection would have been reported.
    await delay(80);
    expect(unhandled).toEqual([]);
  });

  test("answers the watermark once the NOTIFY and its barrier both landed", async () => {
    let notified: string | null = null;
    const cut = createFeedCut({
      watermark: () => Promise.resolve("42"),
      barrier: async (token) => {
        await delay(5);
        expect(token).toBe(notified!);
      },
      notify: async (token) => {
        notified = token;
      },
      deadlineMs: 1_000,
    });
    expect(await cut()).toEqual({ cutXid: "42" });
  });
});
