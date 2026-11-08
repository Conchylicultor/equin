import { describe, expect, test } from "bun:test";
import { fixClaimCarrier } from "./fix-claim";

const none = { fixes: [], fixedBy: [] };
const fixes = { fixes: ["report-1"], fixedBy: [] };
const fixedBy = { fixes: [], fixedBy: ["report-2"] };

describe("fixClaimCarrier", () => {
  test("a push landing commits carries its claims on them", () => {
    expect(
      fixClaimCarrier({ landed: 2, fixed: fixes, message: undefined }),
    ).toEqual({ kind: "rides" });
    expect(
      fixClaimCarrier({ landed: 1, fixed: fixedBy, message: undefined }),
    ).toEqual({ kind: "rides" });
  });

  test("a push claiming nothing is unaffected, landing or not", () => {
    expect(
      fixClaimCarrier({ landed: 0, fixed: none, message: undefined }),
    ).toEqual({ kind: "rides" });
  });

  test("a retroactive claim landing no commit gets an empty commit of its own", () => {
    const carrier = fixClaimCarrier({
      landed: 0,
      fixed: fixedBy,
      message: "claim: abc fixed it",
    });
    expect(carrier.kind).toBe("commit");
    if (carrier.kind === "commit")
      expect(carrier.message).toBe("claim: abc fixed it");
  });

  test("a retroactive claim with no -m to write its commit with is refused", () => {
    for (const message of [undefined, "  "]) {
      const carrier = fixClaimCarrier({ landed: 0, fixed: fixedBy, message });
      expect(carrier.kind).toBe("refuse");
      if (carrier.kind === "refuse")
        expect(carrier.message).toContain("report-2");
    }
  });

  test("--fixes-report on a push landing nothing is refused, even beside a retroactive claim", () => {
    for (const fixed of [
      fixes,
      { fixes: ["report-1"], fixedBy: ["report-2"] },
    ]) {
      const carrier = fixClaimCarrier({ landed: 0, fixed, message: "m" });
      expect(carrier.kind).toBe("refuse");
      if (carrier.kind === "refuse") {
        expect(carrier.message).toContain("report-1");
        expect(carrier.message).toContain("--report-fixed-by");
      }
    }
  });
});
