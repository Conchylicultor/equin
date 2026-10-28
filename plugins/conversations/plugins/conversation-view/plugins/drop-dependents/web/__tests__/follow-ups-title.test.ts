import { describe, expect, it } from "vitest";
import { followUpsTitle } from "../components/drop-dependents-button";

describe("followUpsTitle", () => {
  it("counts the follow-ups dropped with the conversation", () => {
    expect(followUpsTitle(20)).toBe("Dropped with 20 follow-ups");
    expect(followUpsTitle(1)).toBe("Dropped with 1 follow-up");
    expect(followUpsTitle(0)).toBe("Conversation dropped");
  });
});
