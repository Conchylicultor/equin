import { describe, expect, test } from "bun:test";
import { createRoutedCut } from "./routed-cut";

// The cut a floor persist may advance to: refused until the boot catch-up
// routed the changelog behind the LISTEN session, and a refused feed cut is
// an unproven one — never a thrown persist.
describe("createRoutedCut", () => {
  test("refuses before the boot catch-up has routed, without asking the feed", async () => {
    let asked = 0;
    const rc = createRoutedCut(async () => {
      asked++;
      return { cutXid: "250" };
    });
    expect((await rc.cut()).kind).toBe("unproven");
    expect(asked).toBe(0);
  });

  test("after caughtUp, answers the feed's cut", async () => {
    const rc = createRoutedCut(async () => ({ cutXid: "250" }));
    rc.caughtUp();
    expect(await rc.cut()).toEqual({ kind: "cut", cutXid: "250" });
  });

  test("a feed cut that throws (no session, past its deadline) is unproven, with why", async () => {
    const rc = createRoutedCut(() =>
      Promise.reject(new Error("feed cut failed: no LISTEN session")),
    );
    rc.caughtUp();
    const cut = await rc.cut();
    expect(cut.kind).toBe("unproven");
    expect(cut.kind === "unproven" && cut.reason).toContain(
      "no LISTEN session",
    );
  });
});
