import { describe, expect, test } from "bun:test";
import { parseJunit } from "./junit";

// Shape of `bun test --reporter=junit` (1.4.2), trimmed: nested suite per
// `describe`, `file` on every element. A file that failed to load is absent.
const BUN = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" failures="2">
  <testsuite name="a.test.ts" file="a.test.ts" tests="2" failures="1" time="0.25">
    <testcase name="ok" classname="" file="a.test.ts" line="2" />
    <testcase name="bad &lt;x&gt;" classname="" file="a.test.ts" line="3">
      <failure type="AssertionError" message="expect(received).toBe(expected)">AssertionError</failure>
    </testcase>
  </testsuite>
  <testsuite name="b.test.ts" file="b.test.ts" tests="1" failures="1">
    <testsuite name="grp" file="b.test.ts" line="2" tests="1" failures="1">
      <testcase name="inner" classname="grp" file="b.test.ts" line="2" time="0.01">
        <failure type="AssertionError"><![CDATA[AssertionError: x
    at b.test.ts:3]]></failure>
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>`;

// Shape of vitest's junit reporter: the file is the top suite's name, the
// describe path is part of the case name.
const VITEST = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="1" errors="0">
    <testsuite name="fixture/web/__tests__/a.test.tsx" tests="2" failures="1" time="1.5">
        <testcase classname="fixture/web/__tests__/a.test.tsx" name="grp &gt; renders">
        </testcase>
        <testcase classname="fixture/web/__tests__/a.test.tsx" name="grp &gt; breaks">
            <failure message="nope" type="AssertionError">AssertionError: nope</failure>
        </testcase>
    </testsuite>
</testsuites>`;

describe("parseJunit", () => {
  test("bun: failing cases keyed by file and describe path", () => {
    const r = parseJunit(BUN);
    expect(r.failures).toEqual([
      "a.test.ts > bad <x>",
      "b.test.ts > grp > inner",
    ]);
    expect(r.files).toEqual(["a.test.ts", "b.test.ts"]);
  });

  test("bun: per-file cases, failures and time", () => {
    const r = parseJunit(BUN);
    // a.test.ts carries its suite time; b.test.ts has none, so its cases' sum.
    expect(r.byFile).toEqual({
      "a.test.ts": { cases: 2, failed: 1, timeMs: 250 },
      "b.test.ts": { cases: 1, failed: 1, timeMs: 10 },
    });
  });

  test("bun: failure message from the attribute, detail from the body (CDATA too)", () => {
    expect(parseJunit(BUN).failureDetails).toEqual([
      {
        file: "a.test.ts",
        caseId: "bad <x>",
        message: "expect(received).toBe(expected)",
        detail: "AssertionError",
      },
      {
        file: "b.test.ts",
        caseId: "grp > inner",
        message: "AssertionError: x",
        detail: "AssertionError: x\n    at b.test.ts:3",
      },
    ]);
  });

  test("vitest: the file comes from the top suite's name", () => {
    const r = parseJunit(VITEST);
    expect(r.failures).toEqual([
      "fixture/web/__tests__/a.test.tsx > grp > breaks",
    ]);
    expect(r.files).toEqual(["fixture/web/__tests__/a.test.tsx"]);
    expect(r.byFile).toEqual({
      "fixture/web/__tests__/a.test.tsx": { cases: 2, failed: 1, timeMs: 1500 },
    });
    expect(r.failureDetails).toEqual([
      {
        file: "fixture/web/__tests__/a.test.tsx",
        caseId: "grp > breaks",
        message: "nope",
        detail: "AssertionError: nope",
      },
    ]);
  });

  test("an empty report has nothing", () => {
    expect(parseJunit("<testsuites/>")).toEqual({
      failures: [],
      files: [],
      byFile: {},
      failureDetails: [],
    });
  });
});
