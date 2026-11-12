import { describe, expect, test } from "bun:test";
import { firstName, nameInitial, profileName } from "./profile-name";

const named = { username: "jdoe", fullName: "jane Doe" };
const unnamed = { username: "jdoe", fullName: null };
const shown = { displayName: "", showName: true };

describe("profileName", () => {
  test("empty display name: the account's full name, else its login name", () => {
    expect(profileName(named, shown)).toEqual({
      kind: "named",
      name: "jane Doe",
    });
    expect(profileName(unnamed, shown)).toEqual({
      kind: "named",
      name: "jdoe",
    });
  });

  test("a display name of the user's own wins (trimmed)", () => {
    expect(
      profileName(named, { displayName: "  Sam ", showName: true }),
    ).toEqual({ kind: "named", name: "Sam" });
  });

  test("name turned off: nobody in particular, whatever is set", () => {
    expect(profileName(named, { displayName: "Sam", showName: false })).toEqual(
      { kind: "anonymous" },
    );
  });
});

describe("firstName / nameInitial", () => {
  test("first word and its upper-cased initial", () => {
    expect(firstName("jane Doe")).toBe("jane");
    expect(nameInitial("jane Doe")).toBe("J");
    expect(nameInitial("jdoe")).toBe("J");
  });

  test("an astral first character is kept whole", () => {
    expect(nameInitial("🎹 Piano")).toBe("🎹");
  });
});
