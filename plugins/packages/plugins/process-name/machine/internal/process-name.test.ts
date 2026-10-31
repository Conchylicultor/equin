import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKOUT_BUN_DIR,
  checkoutBun,
  linkNamedBinary,
  processName,
  refreshCheckoutBun,
} from "./process-name";

function fakeBin(dir: string, name = "bun"): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
  return path;
}

describe("processName", () => {
  test("kind first, then the id", () => {
    expect(processName("build", "att-1793455063-w71oiq")).toBe(
      "equin · build · att-1793455063-w71oiq",
    );
    expect(processName("central")).toBe("equin · central");
  });

  test("a slash or control character never reaches the file name", () => {
    expect(processName("run", "a/b\nc")).toBe("equin · run · a b c");
  });
});

describe("linkNamedBinary", () => {
  test("the link is the same file, and a relink replaces it", () => {
    const root = mkdtempSync(join(tmpdir(), "process-name-"));
    const first = fakeBin(root, "one");
    const second = fakeBin(root, "two");
    const dir = join(root, "names");
    const a = linkNamedBinary({ bin: first, dir, name: "equin · x" });
    if (a.kind !== "linked") throw new Error("not linked");
    expect(statSync(a.path).ino).toBe(statSync(first).ino);
    const b = linkNamedBinary({ bin: second, dir, name: "equin · x" });
    if (b.kind !== "linked") throw new Error("not linked");
    expect(b.path).toBe(a.path);
    expect(statSync(b.path).ino).toBe(statSync(second).ino);
  });
});

describe("checkout bun", () => {
  test("trusted only while its stamp is newer than mise.lock", () => {
    const root = mkdtempSync(join(tmpdir(), "process-name-"));
    const bun = fakeBin(root);
    expect(checkoutBun(root)).toBeNull();
    const linked = refreshCheckoutBun(root, bun);
    expect(linked).toEqual({
      kind: "linked",
      path: join(root, CHECKOUT_BUN_DIR, "bun"),
    });
    expect(checkoutBun(root)).toBe(join(root, CHECKOUT_BUN_DIR, "bun"));

    // The toolchain moved after the stamp: no longer trusted…
    writeFileSync(join(root, "mise.lock"), "");
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "mise.lock"), later, later);
    expect(checkoutBun(root)).toBeNull();
    // …until a run on the locked Bun records it again.
    utimesSync(join(root, "mise.lock"), new Date(0), new Date(0));
    refreshCheckoutBun(root, fakeBin(root, "newer"));
    expect(statSync(join(root, CHECKOUT_BUN_DIR, "bun")).ino).toBe(
      statSync(join(root, "newer")).ino,
    );
  });
});
