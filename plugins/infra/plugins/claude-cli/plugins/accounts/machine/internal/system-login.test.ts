import { describe, expect, test } from "bun:test";
import { systemLoginOf } from "./system-login";

describe("systemLoginOf", () => {
  test("reads the login's account uuid from the user config", () => {
    expect(
      systemLoginOf(
        JSON.stringify({
          projects: {},
          oauthAccount: { accountUuid: "u-1", organizationUuid: "o-1" },
        }),
      ),
    ).toEqual({ kind: "signed-in", accountUuid: "u-1" });
  });

  test("no oauth login: none", () => {
    expect(systemLoginOf(JSON.stringify({ projects: {} }))).toEqual({
      kind: "none",
    });
    expect(systemLoginOf(JSON.stringify({ oauthAccount: {} }))).toEqual({
      kind: "none",
    });
  });

  test("a file that is not JSON throws", () => {
    expect(() => systemLoginOf("{")).toThrow();
  });
});
