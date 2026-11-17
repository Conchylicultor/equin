import { describe, expect, test } from "bun:test";
import { installIssueUrl, redactPaths } from "./report";

describe("installer report link", () => {
  test("home folders become ~, on macOS and Linux", () => {
    expect(redactPaths("cp /Users/ada/.equin/bin/gateway: denied")).toBe(
      "cp ~/.equin/bin/gateway: denied",
    );
    expect(redactPaths("open /home/ada/equin/x and /home/bob")).toBe(
      "open ~/equin/x and ~",
    );
  });

  test("a new issue labelled install: the pause's title, words, evidence and system — no account name", () => {
    const url = new URL(
      installIssueUrl({
        title: "Blocked by the app you started it from",
        text: "The install builds parts of equin on your computer.",
        evidence: [
          "error in /Users/ada/equin/target",
          "step exit 137 (killed)",
        ],
        release: "v2026.11.17",
        platform: "darwin-arm64",
      }),
    );
    expect(url.pathname).toBe("/equinai/equin/issues/new");
    expect(url.searchParams.get("labels")).toBe("install");
    expect(url.searchParams.get("title")).toBe(
      "Install: Blocked by the app you started it from",
    );
    const body = url.searchParams.get("body") ?? "";
    expect(body).toContain("error in ~/equin/target");
    expect(body).not.toContain("ada");
    expect(body).toContain("Release: v2026.11.17 · system: darwin-arm64");
    expect(body).toContain("install.log");
  });

  test("a long log still fits GitHub's link limit", () => {
    const url = installIssueUrl({
      title: "x",
      text: "y",
      evidence: Array.from(
        { length: 400 },
        (_, i) => `line ${i} ${"z".repeat(80)}`,
      ),
      release: null,
      platform: "linux-x86_64",
    });
    expect(url.length).toBeLessThanOrEqual(7500);
  });
});
