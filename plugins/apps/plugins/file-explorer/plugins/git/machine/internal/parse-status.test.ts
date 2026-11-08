import { describe, expect, test } from "bun:test";
import { parseDiffNameStatusZ } from "@plugins/primitives/plugins/commit-list/server";
import { assembleStatus, parsePorcelainV2Z } from "./parse-status";

const SHA = "871a8ed96e2d036d5c540d98cfb874c9afeea44f";
const H = "78981922613b2afb6025042ff6bd878ac1994e85";

/** NUL-join records the way `-z` emits them. */
const z = (...records: string[]) => records.map((r) => `${r}\0`).join("");

describe("parsePorcelainV2Z", () => {
  test("reads head, changes, and collapsed untracked / ignored folders", () => {
    const out = z(
      `# branch.oid ${SHA}`,
      "# branch.head feat",
      `1 .M N... 100644 100644 100644 ${H} ${H} src/a.ts`,
      `1 A. N... 000000 100644 100644 ${H} ${H} src/new file.ts`,
      `1 D. N... 100644 000000 000000 ${H} ${H} src/gone.ts`,
      `1 AD N... 000000 100644 000000 ${H} ${H} src/never.ts`,
      "? newdir/",
      "? src/u.ts",
      "! node_modules/",
      "! src/z.log",
    );
    const s = parsePorcelainV2Z(out);
    expect(s.head).toBe(SHA);
    expect([...s.vsHead]).toEqual([
      ["src/a.ts", "modified"],
      ["src/new file.ts", "added"],
      ["src/gone.ts", "deleted"],
    ]);
    expect(s.untrackedDirs).toEqual(["newdir"]);
    expect(s.untrackedFiles).toEqual(["src/u.ts"]);
    expect(s.ignoredDirs).toEqual(["node_modules"]);
    expect(s.ignoredFiles).toEqual(["src/z.log"]);
  });

  test("a staged rename reports the new path and consumes the original", () => {
    const out = z(
      `2 R. N... 100644 100644 100644 ${H} ${H} R100 src/c.ts`,
      "src/b.ts",
      "? after.ts",
    );
    const s = parsePorcelainV2Z(out);
    expect([...s.vsHead]).toEqual([["src/c.ts", "renamed"]]);
    expect(s.untrackedFiles).toEqual(["after.ts"]);
  });

  test("an unborn branch has no head; a conflict is modified", () => {
    const out = z(
      "# branch.oid (initial)",
      `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} both.ts`,
    );
    const s = parsePorcelainV2Z(out);
    expect(s.head).toBeNull();
    expect([...s.vsHead]).toEqual([["both.ts", "modified"]]);
  });

  test("an unknown record fails loudly", () => {
    expect(() => parsePorcelainV2Z(z("x what"))).toThrow();
  });
});

describe("assembleStatus", () => {
  const porcelain = parsePorcelainV2Z(
    z(
      `# branch.oid ${SHA}`,
      `1 .M N... 100644 100644 100644 ${H} ${H} src/a.ts`,
      "? src/u.ts",
      "? newdir/",
    ),
  );
  // `diff -M -z --name-status <mergeBase>`: a committed rename plus a.ts.
  const vsMain = parseDiffNameStatusZ(
    "M\0src/a.ts\0R100\0src/b.ts\0src/c.ts\0",
  );

  test("joins vs HEAD and vs main per path; untracked is untracked vs both", () => {
    const s = assembleStatus(porcelain, "base", vsMain);
    expect(s.entries).toEqual({
      "src/a.ts": { vsHead: "modified", vsMain: "modified" },
      "src/c.ts": { vsHead: null, vsMain: "renamed" },
      "src/u.ts": { vsHead: "untracked", vsMain: "untracked" },
    });
    expect(s.untrackedDirs).toEqual(["newdir"]);
    expect(s.mergeBase).toBe("base");
  });

  test("each list keeps its first maxPaths, and says it was cut", () => {
    expect(assembleStatus(porcelain, "base", vsMain).truncated).toBe(false);
    const s = assembleStatus(porcelain, "base", vsMain, 2);
    expect(s.truncated).toBe(true);
    expect(Object.keys(s.entries)).toEqual(["src/a.ts", "src/c.ts"]);
    expect(s.untrackedDirs).toEqual(["newdir"]);
  });

  test("without a merge-base nothing is changed vs main", () => {
    const s = assembleStatus(porcelain, null, []);
    expect(s.entries["src/u.ts"]).toEqual({
      vsHead: "untracked",
      vsMain: null,
    });
    expect(s.entries["src/a.ts"]).toEqual({ vsHead: "modified", vsMain: null });
  });
});
