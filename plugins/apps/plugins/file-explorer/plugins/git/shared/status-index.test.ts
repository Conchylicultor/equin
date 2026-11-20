import { describe, expect, test } from "bun:test";
import type { GitStatus } from "./resources";
import { indexGitStatus, relativeTo } from "./status-index";

const status: GitStatus = {
  head: "h",
  mergeBase: "m",
  entries: {
    "src/a.ts": { vsHead: "modified", vsMain: "modified" },
    "src/deep/b.ts": { vsHead: "modified", vsMain: null },
    "lib/c.ts": { vsHead: null, vsMain: "added" },
  },
  untrackedDirs: ["newdir/sub"],
  truncated: false,
};

describe("indexGitStatus", () => {
  const index = indexGitStatus(status);

  test("an entry is its own; below an untracked folder it is untracked", () => {
    expect(index.entry("src/a.ts")).toEqual({
      vsHead: "modified",
      vsMain: "modified",
    });
    expect(index.entry("src/other.ts")).toBeNull();
    expect(index.entry("newdir/sub")).toEqual({
      vsHead: "untracked",
      vsMain: "untracked",
    });
    expect(index.entry("newdir/sub/x/y.ts")).toEqual({
      vsHead: "untracked",
      vsMain: "untracked",
    });
    // A sibling sharing the prefix is not inside.
    expect(index.entry("newdir/subway.ts")).toBeNull();
  });

  test("a folder rolls up changes below it, vs HEAD or main", () => {
    expect(index.hasChangedDescendant("")).toBe(true);
    expect(index.hasChangedDescendant("src")).toBe(true);
    expect(index.hasChangedDescendant("src/deep")).toBe(true);
    expect(index.hasChangedDescendant("lib")).toBe(true);
    expect(index.hasChangedDescendant("newdir")).toBe(true);
    expect(index.hasChangedDescendant("newdir/sub")).toBe(true);
    expect(index.hasChangedDescendant("other")).toBe(false);
    // A file is not its own descendant.
    expect(index.hasChangedDescendant("src/a.ts")).toBe(false);
  });

  test("vs main rolls up only changes vs main", () => {
    expect(index.hasDescendantChangedVsMain("src")).toBe(true);
    expect(index.hasDescendantChangedVsMain("src/deep")).toBe(false);
    expect(index.hasDescendantChangedVsMain("lib")).toBe(true);
  });

  test("without a merge-base an untracked folder is changed vs HEAD only", () => {
    const noMain = indexGitStatus({ ...status, mergeBase: null, entries: {} });
    expect(noMain.entry("newdir/sub/f")).toEqual({
      vsHead: "untracked",
      vsMain: null,
    });
    expect(noMain.hasChangedDescendant("newdir")).toBe(true);
    expect(noMain.hasDescendantChangedVsMain("newdir")).toBe(false);
  });
});

describe("relativeTo", () => {
  test("the root, a path below it, and one outside", () => {
    expect(relativeTo("/r/repo", "/r/repo")).toBe("");
    expect(relativeTo("/r/repo", "/r/repo/a/b")).toBe("a/b");
    expect(relativeTo("/r/repo", "/r/repository")).toBeNull();
    expect(relativeTo("/", "/etc")).toBe("etc");
  });
});
