import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHELL_OUTPUT_TAIL_BYTES } from "../../core";
import { cutAtLineBoundary, readShellTail } from "./tail-read";

const dir = mkdtempSync(join(tmpdir(), "background-shells-tail-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("cutAtLineBoundary", () => {
  test("a window from byte 0 is kept whole", () => {
    expect(cutAtLineBoundary("abc\ndef", false)).toBe("abc\ndef");
  });
  test("a mid-file window drops its partial first line", () => {
    expect(cutAtLineBoundary("tial\nnext\n", true)).toBe("next\n");
    expect(cutAtLineBoundary("5%\r 60%", true)).toBe(" 60%");
  });
  test("a window with no break is one long line, kept", () => {
    expect(cutAtLineBoundary("xxxx", true)).toBe("xxxx");
  });
});

describe("readShellTail", () => {
  test("a missing file is gone", async () => {
    expect(await readShellTail(join(dir, "nope.output"))).toEqual({
      kind: "gone",
    });
  });

  test("a small file comes back whole", async () => {
    const path = join(dir, "small.output");
    writeFileSync(path, "tick 1\ntick 2\n");
    expect(await readShellTail(path)).toEqual({
      kind: "present",
      size: 14,
      tail: "tick 1\ntick 2\n",
      truncated: false,
    });
  });

  test("a large file is cut to the window at a line boundary", async () => {
    const path = join(dir, "large.output");
    const line = "x".repeat(99) + "\n";
    const body =
      line.repeat(Math.ceil((SHELL_OUTPUT_TAIL_BYTES * 2) / 100)) + "last\n";
    writeFileSync(path, body);
    const out = await readShellTail(path);
    if (out.kind !== "present") throw new Error("expected present");
    expect(out.truncated).toBe(true);
    expect(out.size).toBe(body.length);
    expect(out.tail.length).toBeLessThanOrEqual(SHELL_OUTPUT_TAIL_BYTES);
    expect(out.tail.startsWith("x".repeat(99) + "\n")).toBe(true);
    expect(out.tail.endsWith("last\n")).toBe(true);
  });
});
