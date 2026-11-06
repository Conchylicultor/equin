import { describe, expect, test } from "bun:test";
import { declarePageInputs, pageInput, receivePageInput } from "./page-inputs";

// The store is module-global (one per host realm): each test uses its own key.
describe("page inputs", () => {
  test("a key no page declared reads absent", async () => {
    expect(await pageInput("t.absent").read()).toEqual({ kind: "absent" });
  });

  test("a declared key waits for its first value, then reads the newest", async () => {
    declarePageInputs(["t.wait"]);
    const input = pageInput("t.wait");
    const first = input.read();
    receivePageInput("t.wait", { kind: "value", value: { n: 1 } });
    expect(await first).toEqual({ kind: "value", value: { n: 1 } });
    receivePageInput("t.wait", { kind: "value", value: { n: 2 } });
    expect(await input.read()).toEqual({ kind: "value", value: { n: 2 } });
  });

  test("a page's failed read rejects", () => {
    declarePageInputs(["t.failed"]);
    receivePageInput("t.failed", { kind: "failed", message: "socket down" });
    expect(pageInput("t.failed").read()).rejects.toThrow(/socket down/);
  });

  test("watch hears a declaration and each value, until stopped", () => {
    let heard = 0;
    const stop = pageInput("t.watch").watch(() => heard++);
    declarePageInputs(["t.watch"]);
    declarePageInputs(["t.watch"]); // re-declaring is a no-op
    receivePageInput("t.watch", { kind: "value", value: 1 });
    stop();
    receivePageInput("t.watch", { kind: "value", value: 2 });
    expect(heard).toBe(2);
  });

  test("a value for a key no page declared is refused", () => {
    expect(() =>
      receivePageInput("t.undeclared", { kind: "value", value: 1 }),
    ).toThrow(/did not declare/);
  });
});
