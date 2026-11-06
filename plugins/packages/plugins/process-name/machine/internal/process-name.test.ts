import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKOUT_BUN_DIR,
  checkoutBun,
  cloneNamedBinary,
  processName,
  refreshCheckoutBun,
} from "./process-name";

function fakeBin(dir: string, name = "bun"): AppPath {
  const path = asAppPath(join(dir, name));
  // The name in the body: two fake Buns differ in size, as two Buns do.
  writeFileSync(path, `#!/bin/sh\n# ${name}\n`, { mode: 0o755 });
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

describe("cloneNamedBinary", () => {
  test("the name is a file of its own with the binary's bytes, and a new binary replaces it", () => {
    const root = asAppPath(mkdtempSync(join(tmpdir(), "process-name-")));
    const first = fakeBin(root, "one");
    const second = fakeBin(root, "two");
    const dir = asAppPath(join(root, "names"));
    const a = cloneNamedBinary({ bin: first, dir, name: "equin · x" });
    if (a.kind !== "cloned") throw new Error("not cloned");
    expect(statSync(a.path).ino).not.toBe(statSync(first).ino);
    expect(statSync(a.path).nlink).toBe(1);
    expect(statSync(first).nlink).toBe(1);
    expect(readFileSync(a.path, "utf8")).toBe(readFileSync(first, "utf8"));
    expect(statSync(a.path).mtimeMs).toBe(statSync(first).mtimeMs);
    const b = cloneNamedBinary({ bin: second, dir, name: "equin · x" });
    if (b.kind !== "cloned") throw new Error("not cloned");
    expect(b.path).toBe(a.path);
    expect(readFileSync(b.path, "utf8")).toBe(readFileSync(second, "utf8"));
  });

  test("a current clone is left in place — no fresh file to scan", () => {
    const root = asAppPath(mkdtempSync(join(tmpdir(), "process-name-")));
    const bin = fakeBin(root);
    const dir = asAppPath(join(root, "names"));
    const a = cloneNamedBinary({ bin, dir, name: "equin · x" });
    if (a.kind !== "cloned") throw new Error("not cloned");
    const ino = statSync(a.path).ino;
    cloneNamedBinary({ bin, dir, name: "equin · x" });
    expect(statSync(a.path).ino).toBe(ino);
  });

  test("an old build's hardlink at the name is replaced by a clone", () => {
    const root = asAppPath(mkdtempSync(join(tmpdir(), "process-name-")));
    const bin = fakeBin(root);
    const dir = asAppPath(join(root, "names"));
    mkdirSync(dir);
    linkSync(bin, join(dir, "equin · x"));
    const named = cloneNamedBinary({ bin, dir, name: "equin · x" });
    if (named.kind !== "cloned") throw new Error("not cloned");
    expect(statSync(named.path).ino).not.toBe(statSync(bin).ino);
    expect(statSync(bin).nlink).toBe(1);
  });
});

/** The machine-wide verbs dir, in its own temp root. */
function verbsDir(): AppPath {
  return asAppPath(
    join(mkdtempSync(join(tmpdir(), "process-name-verbs-")), "bun-1.0.0"),
  );
}

describe("checkout bun", () => {
  test("trusted only while its stamp is newer than mise.lock", () => {
    const root = asAppPath(mkdtempSync(join(tmpdir(), "process-name-")));
    const bun = fakeBin(root);
    expect(checkoutBun(root)).toBeNull();
    const linked = refreshCheckoutBun(root, bun, verbsDir());
    expect(linked).toEqual({
      kind: "cloned",
      path: joinAppPath(root, CHECKOUT_BUN_DIR, "bun"),
    });
    expect(checkoutBun(root)).toBe(joinAppPath(root, CHECKOUT_BUN_DIR, "bun"));

    // The toolchain moved after the stamp: no longer trusted…
    writeFileSync(join(root, "mise.lock"), "");
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "mise.lock"), later, later);
    expect(checkoutBun(root)).toBeNull();
    // …until a run on the locked Bun records it again.
    utimesSync(join(root, "mise.lock"), new Date(0), new Date(0));
    refreshCheckoutBun(root, fakeBin(root, "newer"), verbsDir());
    expect(readFileSync(join(root, CHECKOUT_BUN_DIR, "bun"), "utf8")).toBe(
      readFileSync(join(root, "newer"), "utf8"),
    );
    expect(checkoutBun(root)).toBe(joinAppPath(root, CHECKOUT_BUN_DIR, "bun"));
  });

  test("verbs points at the machine-wide dir, followed when it moves", () => {
    const root = asAppPath(mkdtempSync(join(tmpdir(), "process-name-")));
    const bun = fakeBin(root);
    const first = verbsDir();
    refreshCheckoutBun(root, bun, first);
    const link = join(root, CHECKOUT_BUN_DIR, "verbs");
    expect(readlinkSync(link)).toBe(first);
    expect(statSync(first).isDirectory()).toBe(true);
    // Unchanged: left alone.
    const before = lstatSync(link).ino;
    refreshCheckoutBun(root, bun, first);
    expect(lstatSync(link).ino).toBe(before);
    // Another Bun version: repointed.
    const second = verbsDir();
    refreshCheckoutBun(root, bun, second);
    expect(readlinkSync(link)).toBe(second);
  });

  test("an older build's hardlinked bun becomes a clone; per-checkout verb names go", () => {
    const root = asAppPath(mkdtempSync(join(tmpdir(), "process-name-")));
    const bun = fakeBin(root);
    const dir = join(root, CHECKOUT_BUN_DIR);
    mkdirSync(dir, { recursive: true });
    linkSync(bun, join(dir, "bun"));
    linkSync(bun, join(dir, "equin · run · att-x"));
    linkSync(bun, join(dir, "equin · test · att-x.4242"));
    refreshCheckoutBun(root, bun, verbsDir());
    expect(statSync(join(dir, "bun")).nlink).toBe(1);
    expect(existsSync(join(dir, "equin · run · att-x"))).toBe(false);
    // A script's clone in flight is its own business.
    expect(statSync(join(dir, "equin · test · att-x.4242")).ino).toBe(
      statSync(bun).ino,
    );
  });
});
