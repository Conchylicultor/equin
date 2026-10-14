import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDirTrusted,
  ensureDirTrusted,
  isDirTrusted,
  withDirTrusted,
} from "./claude-trust";

// Neutral fake paths under a temp dir: none of these is read as a directory.
const BASE = mkdtempSync(join(tmpdir(), "claude-trust-test-"));
const HOME = join(BASE, "home");
const ROOT = join(HOME, "data", "workspaces");
const A = join(BASE, "a");
const config = (projects: Record<string, Record<string, unknown>>) =>
  JSON.stringify(
    { numStartups: 3, projects, other: { keep: [1, 2] } },
    null,
    2,
  );

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

describe("withDirTrusted", () => {
  test("adds the trust flag and touches nothing else", () => {
    const before = config({ [A]: { hasTrustDialogAccepted: true, x: 1 } });
    const after = withDirTrusted(before, ROOT);
    expect(after.kind).toBe("changed");
    if (after.kind !== "changed") return;
    expect(JSON.parse(after.text)).toEqual({
      numStartups: 3,
      projects: {
        [A]: { hasTrustDialogAccepted: true, x: 1 },
        [ROOT]: { hasTrustDialogAccepted: true },
      },
      other: { keep: [1, 2] },
    });
  });

  test("keeps the dir's other project settings", () => {
    const after = withDirTrusted(
      config({
        [ROOT]: { hasTrustDialogAccepted: false, allowedTools: ["Bash"] },
      }),
      ROOT,
    );
    if (after.kind !== "changed") throw new Error("expected a change");
    expect(JSON.parse(after.text).projects[ROOT]).toEqual({
      hasTrustDialogAccepted: true,
      allowedTools: ["Bash"],
    });
  });

  test("idempotent: a trusted dir, or one under a trusted ancestor, is unchanged", () => {
    const once = withDirTrusted(config({}), ROOT);
    if (once.kind !== "changed") throw new Error("expected a change");
    expect(withDirTrusted(once.text, ROOT).kind).toBe("unchanged");
    expect(
      withDirTrusted(config({ [HOME]: { hasTrustDialogAccepted: true } }), ROOT)
        .kind,
    ).toBe("unchanged");
  });

  test("serializes as Claude Code writes the file", () => {
    const after = withDirTrusted(config({}), ROOT);
    if (after.kind !== "changed") throw new Error("expected a change");
    expect(after.text.startsWith('{\n  "numStartups": 3,')).toBe(true);
    expect(after.text.endsWith("\n")).toBe(false);
  });

  test("an unparseable or non-object file throws", () => {
    expect(() => withDirTrusted("{ nope", ROOT)).toThrow("not valid JSON");
    expect(() => withDirTrusted("[]", ROOT)).toThrow("not a JSON object");
  });
});

describe("isDirTrusted", () => {
  test("walks ancestors", () => {
    const text = config({ [ROOT]: { hasTrustDialogAccepted: true } });
    expect(isDirTrusted(text, `${ROOT}/att-1`)).toBe(true);
    expect(isDirTrusted(text, HOME)).toBe(false);
  });
});

describe("ensureDirTrusted / assertDirTrusted on a file", () => {
  const dir = BASE;

  test("writes once, keeps the mode, and the assert then passes", () => {
    const path = join(dir, "claude.json");
    writeFileSync(path, config({}), { mode: 0o600 });
    expect(() => assertDirTrusted(`${ROOT}/att-1`, path)).toThrow(
      "restart the backend",
    );
    ensureDirTrusted(ROOT, path);
    const written = readFileSync(path, "utf8");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    ensureDirTrusted(ROOT, path);
    expect(readFileSync(path, "utf8")).toBe(written);
    assertDirTrusted(`${ROOT}/att-1`, path);
  });
});
