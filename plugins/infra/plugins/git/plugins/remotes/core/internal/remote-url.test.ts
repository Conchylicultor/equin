import { describe, expect, test } from "bun:test";
import { normalizeRepoUrl, remoteTransport, sameRepoUrl } from "./remote-url";

const CANONICAL = "https://github.com/Conchylicultor/equin";

describe("normalizeRepoUrl", () => {
  test("reads scp-like syntax, which is not a URL", () => {
    expect(normalizeRepoUrl("git@github.com:Owner/repo.git")).toEqual({
      kind: "parsed",
      host: "github.com",
      path: "owner/repo",
    });
  });

  test("reads https, dropping the .git and the trailing slash", () => {
    expect(normalizeRepoUrl("https://github.com/Owner/repo.git/")).toEqual({
      kind: "parsed",
      host: "github.com",
      path: "owner/repo",
    });
  });

  test("reads ssh:// with a port", () => {
    expect(
      normalizeRepoUrl("ssh://git@git.example.com:2222/owner/repo"),
    ).toEqual({ kind: "parsed", host: "git.example.com", path: "owner/repo" });
  });

  // A local path is a repository this module cannot identify beyond its text —
  // resolving symlinks to decide otherwise is not its job.
  test("a local path stays opaque", () => {
    expect(normalizeRepoUrl("/tmp/upstream.git")).toEqual({
      kind: "opaque",
      raw: "/tmp/upstream.git",
    });
    expect(normalizeRepoUrl("../sibling")).toEqual({
      kind: "opaque",
      raw: "../sibling",
    });
  });
});

describe("sameRepoUrl", () => {
  test("the four spellings of one repo are one repo", () => {
    for (const spelling of [
      "https://github.com/Conchylicultor/equin.git",
      "https://github.com/conchylicultor/equin/",
      "git@github.com:Conchylicultor/equin.git",
      "ssh://git@github.com/Conchylicultor/equin",
    ]) {
      expect(sameRepoUrl(spelling, CANONICAL)).toBe(true);
    }
  });

  test("a fork is not the canonical repo", () => {
    expect(sameRepoUrl("git@github.com:someone/equin.git", CANONICAL)).toBe(
      false,
    );
  });

  test("a different host is a different repo", () => {
    expect(
      sameRepoUrl("https://gitlab.com/Conchylicultor/equin", CANONICAL),
    ).toBe(false);
  });

  test("two local paths compare as text, and never as equal to a URL", () => {
    expect(sameRepoUrl("/tmp/up.git", "/tmp/up.git")).toBe(true);
    expect(sameRepoUrl("/tmp/up.git", "/tmp/other.git")).toBe(false);
    expect(sameRepoUrl("/tmp/up.git", CANONICAL)).toBe(false);
  });
});

describe("remoteTransport", () => {
  const cases: [string, "filesystem" | "network"][] = [
    ["/tmp/upstream", "filesystem"],
    ["/tmp/upstream.git/", "filesystem"],
    ["../other", "filesystem"],
    ["upstream", "filesystem"],
    ["./dir:with-colon", "filesystem"],
    ["file:///tmp/upstream", "filesystem"],
    ["FILE:///tmp/upstream", "filesystem"],
    ["C:\\repos\\x", "filesystem"],
    ["C:/repos/x", "filesystem"],
    ["https://github.com/owner/repo.git", "network"],
    ["ssh://git@host:2222/owner/repo", "network"],
    ["git://host/repo", "network"],
    ["git@github.com:Owner/repo.git", "network"],
    ["myhost:repo", "network"],
    ["ext::ssh host git-upload-pack repo", "network"],
  ];
  for (const [url, expected] of cases) {
    test(`${url} → ${expected}`, () => {
      expect(remoteTransport(url)).toBe(expected);
    });
  }
});
