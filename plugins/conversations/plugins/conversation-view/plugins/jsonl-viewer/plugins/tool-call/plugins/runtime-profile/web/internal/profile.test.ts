import { describe, expect, test } from "bun:test";
import { describeProfileInput, readProfile } from "./profile";

describe("runtime profile", () => {
  test("non-JSON is text", () => {
    expect(readProfile("boom")).toEqual({ kind: "text", text: "boom" });
  });
  test("parses a profile", () => {
    const r = readProfile(
      JSON.stringify({
        kinds: {
          http: {
            aggregates: [
              { label: "GET /x", count: 2, avgMs: 3, maxMs: 9, recentMaxMs: 9 },
            ],
          },
        },
      }),
    );
    expect(r.kind).toBe("profile");
  });
  test("describe", () => {
    expect(describeProfileInput({ kind: "db", limit: 5 })).toBe(
      "this worktree · db · top 5",
    );
  });
});
