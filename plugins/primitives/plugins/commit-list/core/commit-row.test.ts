import { describe, expect, test } from "bun:test";
import {
  commitCoAuthors,
  commitTrailerValues,
  parseGitIdent,
  type CommitRow,
} from "./commit-row";

const commit = (trailers: CommitRow["trailers"]): CommitRow => ({
  sha: "a".repeat(40),
  shortSha: "aaaaaaa",
  subject: "x",
  authorName: "A",
  authorEmail: "a@x",
  authoredAt: "2026-11-15T02:35:00Z",
  parents: [],
  trailers,
});

describe("commit trailers", () => {
  test("commitTrailerValues keeps every repeat, case-insensitively", () => {
    const c = commit([
      { key: "Co-authored-by", value: "One <1@x>" },
      { key: "Other", value: "z" },
      { key: "Co-Authored-By", value: "Two <2@x>" },
    ]);
    expect(commitTrailerValues(c, "co-authored-by")).toEqual([
      "One <1@x>",
      "Two <2@x>",
    ]);
    expect(commitCoAuthors(c)).toEqual([
      { name: "One", email: "1@x" },
      { name: "Two", email: "2@x" },
    ]);
  });

  test("parseGitIdent", () => {
    expect(parseGitIdent("Claude Opus 5.5 <noreply@anthropic.com>")).toEqual({
      name: "Claude Opus 5.5",
      email: "noreply@anthropic.com",
    });
    expect(parseGitIdent("Just A Name")).toEqual({
      name: "Just A Name",
      email: "",
    });
    expect(parseGitIdent("<only@mail>")).toEqual({
      name: "only@mail",
      email: "only@mail",
    });
  });
});
