import { describe, expect, test } from "bun:test";
import { decideStop, evaluateStop } from "./decide";
import type { StopGateEntry, StopVerdict, StopWaiverEntry } from "./registry";

const allow = { kind: "allow" } as const;
const block = (reason: string) => ({ kind: "block", reason }) as const;

describe("decideStop", () => {
  test("no gate: allow", () => {
    expect(decideStop([], [])).toEqual({ decision: "allow", reason: null });
  });

  test("every gate allows: allow, whatever the waivers", () => {
    expect(decideStop([allow, allow], ["woken later"])).toEqual({
      decision: "allow",
      reason: null,
    });
  });

  test("a gate blocks, no waiver: block with its reason", () => {
    expect(decideStop([allow, block("submit a report")], [null])).toEqual({
      decision: "block",
      reason: "submit a report",
    });
  });

  test("several gates block: their reasons joined", () => {
    expect(decideStop([block("a"), block("b")], [])).toEqual({
      decision: "block",
      reason: "a\n\nb",
    });
  });

  test("a waiver waives a block: allow with the waiver's reason", () => {
    expect(decideStop([block("a")], [null, "you will be woken"])).toEqual({
      decision: "allow",
      reason: "you will be woken",
    });
  });
});

describe("evaluateStop", () => {
  const gate = (
    id: string,
    verdict: () => Promise<StopVerdict>,
  ): StopGateEntry => ({ id, check: verdict });

  test("asks the waivers only when a gate blocks", async () => {
    let asked = 0;
    const waiver: StopWaiverEntry = {
      id: "w",
      waives: () => {
        asked++;
        return Promise.resolve("woken");
      },
    };
    expect(
      await evaluateStop(
        "c",
        [gate("g", () => Promise.resolve(allow))],
        [waiver],
      ),
    ).toEqual({ decision: "allow", reason: null });
    expect(asked).toBe(0);
    expect(
      await evaluateStop(
        "c",
        [gate("g", () => Promise.resolve(block("report")))],
        [waiver],
      ),
    ).toEqual({ decision: "allow", reason: "woken" });
    expect(asked).toBe(1);
  });

  test("passes the conversation to every gate", async () => {
    const seen: string[] = [];
    const g: StopGateEntry = {
      id: "g",
      check: (id) => {
        seen.push(id);
        return Promise.resolve(allow);
      },
    };
    await evaluateStop("conv-1", [g], []);
    expect(seen).toEqual(["conv-1"]);
  });

  test("a gate that throws fails the decision", async () => {
    let error: unknown;
    try {
      await evaluateStop(
        "c",
        [gate("g", () => Promise.reject(new Error("db down")))],
        [],
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
  });
});
