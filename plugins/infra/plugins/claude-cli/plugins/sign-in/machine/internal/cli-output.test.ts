import { describe, expect, test } from "bun:test";
import {
  failureMessage,
  parseBrowserUrl,
  parseManualUrl,
  parseSetupToken,
  signInArgs,
} from "./cli-output";

// What the bundled 2.1.310 printed for `auth login`, piped, no TTY.
const LOGIN_OUTPUT =
  "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=abc\nPaste code here if prompted > ";

describe("signInArgs", () => {
  test("signs the computer in with the picked method", () => {
    expect(signInArgs({ kind: "computer", method: "claudeai" })).toEqual([
      "auth",
      "login",
    ]);
    expect(signInArgs({ kind: "computer", method: "console" })).toEqual([
      "auth",
      "login",
      "--console",
    ]);
    expect(signInArgs({ kind: "computer", method: "sso" })).toEqual([
      "auth",
      "login",
      "--sso",
    ]);
  });

  test("adds an account through setup-token", () => {
    expect(signInArgs({ kind: "new-account", name: "Work" })).toEqual([
      "setup-token",
    ]);
  });
});

describe("parseManualUrl", () => {
  test("reads the page for another device", () => {
    expect(parseManualUrl(LOGIN_OUTPUT)).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=abc",
    );
  });

  test("is null before it is printed", () => {
    expect(parseManualUrl("")).toBeNull();
    expect(parseManualUrl("Opening browser to sign in…\n")).toBeNull();
  });

  test("reads through terminal colours", () => {
    expect(
      parseManualUrl(
        "\u001b[2mIf the browser didn't open, visit: https://x.y/z\u001b[0m\n",
      ),
    ).toBe("https://x.y/z");
  });
});

describe("parseBrowserUrl", () => {
  test("reads the latest page handed to the browser", () => {
    expect(parseBrowserUrl("https://a.b/1\nhttps://a.b/2\n")).toBe(
      "https://a.b/2",
    );
  });

  test("is null before anything was handed", () => {
    expect(parseBrowserUrl("")).toBeNull();
    expect(parseBrowserUrl("\n")).toBeNull();
  });
});

describe("parseSetupToken", () => {
  test("finds the token wherever it is printed", () => {
    expect(
      parseSetupToken(
        "Your token:\n\u001b[1msk-ant-oat01-AbC_d-9\u001b[0m\nStore it safely.",
      ),
    ).toEqual({ kind: "token", token: "sk-ant-oat01-AbC_d-9" });
  });

  test("an API key is not a token", () => {
    expect(parseSetupToken("sk-ant-api03-xyz")).toEqual({ kind: "no-token" });
  });

  test("nothing printed is no token", () => {
    expect(parseSetupToken("")).toEqual({ kind: "no-token" });
  });
});

describe("failureMessage", () => {
  test("is Claude Code's last line, never its prompt", () => {
    expect(
      failureMessage(
        "Opening browser…\nOAuth error: invalid code\nPaste code here if prompted > ",
        1,
      ),
    ).toBe("OAuth error: invalid code");
  });

  test("reads an error printed after the prompt", () => {
    expect(
      failureMessage("Paste code here if prompted > Invalid code\n", 1),
    ).toBe("Invalid code");
  });

  test("masks a credential", () => {
    expect(failureMessage("failed for sk-ant-oat01-secret_1", 1)).toBe(
      "failed for sk-ant-…",
    );
  });

  test("says so when Claude Code said nothing", () => {
    expect(failureMessage("", 3)).toBe(
      "Claude Code's sign-in stopped (exit code 3) without saying why.",
    );
  });
});
