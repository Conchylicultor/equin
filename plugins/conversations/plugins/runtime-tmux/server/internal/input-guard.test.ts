import { describe, expect, test } from "bun:test";
import { InputNotEmptyError } from "@plugins/conversations/server";
import { clearDraft, type InputBoxIo } from "./input-guard";

/**
 * A pane that answers each read with the next scripted capture (the last one
 * repeats), on a fake clock the sleeps advance. Records every C-c.
 */
function scriptedPane(reads: (string | null)[]) {
  let at = 0;
  let clock = 0;
  const log = { reads: 0, abortLines: 0 };
  const io: InputBoxIo = {
    read: async () => {
      log.reads++;
      return reads[Math.min(at++, reads.length - 1)]!;
    },
    abortLine: async () => {
      log.abortLines++;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { io, log };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("clearDraft", () => {
  test("an empty box is left alone: no C-c, which would stop a working agent", async () => {
    const { io, log } = scriptedPane([""]);
    expect(await clearDraft("conv-a", false, io)).toBe("");
    expect(log.abortLines).toBe(0);
  });

  test("an unreadable box is reported as such, untouched", async () => {
    const { io, log } = scriptedPane([null]);
    expect(await clearDraft("conv-a", false, io)).toBeNull();
    expect(log.abortLines).toBe(0);
  });

  test("a draft gets ONE C-c, then the box is polled until it reads empty", async () => {
    const { io, log } = scriptedPane(["stale", "stale", "stale", ""]);
    expect(await clearDraft("conv-a", false, io)).toBe("stale");
    expect(log.abortLines).toBe(1);
  });

  test("a box that keeps its text throws, and nothing is typed after it", async () => {
    const { io, log } = scriptedPane(["stale"]);
    const err = await rejection(clearDraft("conv-a", false, io));
    expect(err).toBeInstanceOf(InputNotEmptyError);
    expect((err as InputNotEmptyError).draft).toBe("stale");
    expect(log.abortLines).toBe(1);
  });

  test("Stop waits for the interrupted turn to be put back, then clears it", async () => {
    const { io, log } = scriptedPane(["", "", "the stopped turn", ""]);
    expect(await clearDraft("conv-a", true, io)).toBe("the stopped turn");
    expect(log.abortLines).toBe(1);
  });

  test("Stop with nothing put back gives up after the bound, sending no C-c", async () => {
    const { io, log } = scriptedPane([""]);
    expect(await clearDraft("conv-a", true, io)).toBe("");
    expect(log.abortLines).toBe(0);
    expect(log.reads).toBeGreaterThan(1);
  });
});
