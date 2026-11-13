import { describe, expect, test } from "bun:test";
import { extensionStanding } from "./standing";

const built = { kind: "built", path: "/x/shell", digest: "d1" } as const;

describe("extensionStanding", () => {
  test("no shell yet: not built", () => {
    expect(
      extensionStanding(
        { kind: "absent", path: "/x/shell" },
        { kind: "never" },
      ),
    ).toEqual({ kind: "not-built" });
  });
  test("a shell never opened: not connected", () => {
    expect(extensionStanding(built, { kind: "never" })).toEqual({
      kind: "not-connected",
    });
  });
  test("opened on the served shell: up to date; on another: update pending", () => {
    expect(
      extensionStanding(built, { kind: "seen", seenAt: 5, shellDigest: "d1" }),
    ).toEqual({ kind: "up-to-date", seenAt: 5 });
    expect(
      extensionStanding(built, { kind: "seen", seenAt: 5, shellDigest: "d0" }),
    ).toEqual({ kind: "update-pending", seenAt: 5 });
  });
});
