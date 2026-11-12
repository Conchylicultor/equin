import { describe, expect, test } from "bun:test";
import { declarePageInputs, pageInput, receivePageInput } from "./page-inputs";

// The store is module-global (one per host realm): each test uses its own key.
describe("page inputs", () => {
  test("a key no page declared reads absent", () => {
    expect(pageInput("t.absent").read()).toEqual({ kind: "absent" });
  });

  test("a declared key reads pending until its first value, then the newest — never waiting", () => {
    declarePageInputs(["t.wait"]);
    const input = pageInput("t.wait");
    expect(input.read()).toEqual({ kind: "pending" });
    receivePageInput("t.wait", { kind: "value", value: { n: 1 } });
    expect(input.read()).toEqual({ kind: "value", value: { n: 1 } });
    receivePageInput("t.wait", { kind: "value", value: { n: 2 } });
    expect(input.read()).toEqual({ kind: "value", value: { n: 2 } });
  });

  test("a page's failed read reads failed, with its message", () => {
    declarePageInputs(["t.failed"]);
    receivePageInput("t.failed", { kind: "failed", message: "socket down" });
    expect(pageInput("t.failed").read()).toEqual({
      kind: "failed",
      message: "socket down",
    });
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
