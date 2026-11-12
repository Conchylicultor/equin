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
  readdirSync,
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
  refreshCheckoutBun,
} from "./process-name";

function fakeBin(dir: string, name = "bun"): AppPath {
  const path = asAppPath(join(dir, name));
  // The name in the body: two fake Buns differ in size, as two Buns do.
  writeFileSync(path, `#!/bin/sh\n# ${name}\n`, { mode: 0o755 });
  return path;
}

describe("cloneNamedBinary", () => {
  test("the name is a file of its own with the binary's bytes, and a new binary replaces it", async () => {
    const root = asAppPath(mkdtempSync(join(tmpdir(), "process-name-")));
    const first = fakeBin(root, "one");
    const second = fakeBin(root, "two");
    const dir = asAppPath(join(root, "names"));
    const a = await cloneNamedBinary({ bin: first, dir, name: "equin · x" });
    if (a.kind !== "cloned") throw new Error("not cloned");
    expect(statSync(a.path).ino).not.toBe(statSync(first).ino);
    expect(statSync(a.path).nlink).toBe(1);
    expect(statSync(first).nlink).toBe(1);
    expect(readFileSync(a.path, "utf8")).toBe(readFileSync(first, "utf8"));
    expect(statSync(a.path).mtimeMs).toBe(statSync(first).mtimeMs);
    const b = await cloneNamedBinary({ bin: second, dir, name: "equin · x" });
    if (b.kind !== "cloned") throw new Error("not cloned");
    expect(b.path).toBe(a.path);
    expect(readFileSync(b.path, "utf8")).toBe(readFileSync(second, "utf8"));
  });

  test("a current clone is left in place — no fresh file to scan", async () => {
    const root = asAppPath(mkdtempSync(join(tmpdir(), "process-name-")));
    const bin = fakeBin(root);
    const dir = asAppPath(join(root, "names"));
    const a = await cloneNamedBinary({ bin, dir, name: "equin · x" });
    if (a.kind !== "cloned") throw new Error("not cloned");
    const ino = statSync(a.path).ino;
    await cloneNamedBinary({ bin, dir, name: "equin · x" });
    expect(statSync(a.path).ino).toBe(ino);
  });

  test("a dead writer's staging is removed, even beside a current clone; a live one's is kept", async () => {
    const root = asAppPath(mkdtempSync(join(tmpdir(), "process-name-")));
    const bin = fakeBin(root);
    const dir = asAppPath(join(root, "names"));
    await cloneNamedBinary({ bin, dir, name: "equin · x" });
    const exited = Bun.spawn(["true"]);
    await exited.exited;
    const dead = String(exited.pid);
    // The hardlink builds' pid-only name, and today's `<pid>.<seq>`.
    linkSync(bin, join(dir, `.${dead}.tmp`));
    writeFileSync(join(dir, `.${dead}.3.tmp`), "");
    writeFileSync(join(dir, `.verbs.${dead}.1.tmp`), "");
    const live = `.${String(process.ppid)}.1.tmp`;
    writeFileSync(join(dir, live), "");
    await cloneNamedBinary({ bin, dir, name: "equin · x" });
    expect(readdirSync(dir).sort()).toEqual(
      [live, "equin · x", ".locks"].sort(),
    );
    expect(statSync(bin).nlink).toBe(1);
  });

  test("concurrent makers of one name make it once: none renames over another's file", async () => {
    const root = asAppPath(mkdtempSync(join(tmpdir(), "process-name-")));
    const bin = fakeBin(root);
    const dir = asAppPath(join(root, "names"));
    const inos = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const named = await cloneNamedBinary({ bin, dir, name: "equin · x" });
        if (named.kind !== "cloned") throw new Error("not cloned");
        // What a process exec'ing it as soon as its start returned would run.
        return statSync(named.path).ino;
      }),
    );
    expect(new Set(inos).size).toBe(1);
    expect(statSync(join(dir, "equin · x")).ino).toBe(inos[0]!);
  });

  test("an old build's hardlink at the name is replaced by a clone", async () => {
    const root = asAppPath(mkdtempSync(join(tmpdir(), "process-name-")));
    const bin = fakeBin(root);
    const dir = asAppPath(join(root, "names"));
    mkdirSync(dir);
    linkSync(bin, join(dir, "equin · x"));
    const named = await cloneNamedBinary({ bin, dir, name: "equin · x" });
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
  test("trusted only while its stamp is newer than mise.lock", async () => {
    const root = asAppPath(mkdtempSync(join(tmpdir(), "process-name-")));
    const bun = fakeBin(root);
    expect(await checkoutBun(root)).toBeNull();
    const linked = await refreshCheckoutBun(root, bun, verbsDir());
    expect(linked).toEqual({
      kind: "cloned",
      path: joinAppPath(root, CHECKOUT_BUN_DIR, "bun"),
    });
    expect(await checkoutBun(root)).toBe(
      joinAppPath(root, CHECKOUT_BUN_DIR, "bun"),
    );

    // The toolchain moved after the stamp: no longer trusted…
    writeFileSync(join(root, "mise.lock"), "");
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "mise.lock"), later, later);
    expect(await checkoutBun(root)).toBeNull();
    // …until a run on the locked Bun records it again.
    utimesSync(join(root, "mise.lock"), new Date(0), new Date(0));
    await refreshCheckoutBun(root, fakeBin(root, "newer"), verbsDir());
    expect(readFileSync(join(root, CHECKOUT_BUN_DIR, "bun"), "utf8")).toBe(
      readFileSync(join(root, "newer"), "utf8"),
    );
    expect(await checkoutBun(root)).toBe(
      joinAppPath(root, CHECKOUT_BUN_DIR, "bun"),
    );
  });

  test("verbs points at the machine-wide dir, followed when it moves", async () => {
    const root = asAppPath(mkdtempSync(join(tmpdir(), "process-name-")));
    const bun = fakeBin(root);
    const first = verbsDir();
    await refreshCheckoutBun(root, bun, first);
    const link = join(root, CHECKOUT_BUN_DIR, "verbs");
    expect(readlinkSync(link)).toBe(first);
    expect(statSync(first).isDirectory()).toBe(true);
    // Unchanged: left alone.
    const before = lstatSync(link).ino;
    await refreshCheckoutBun(root, bun, first);
    expect(lstatSync(link).ino).toBe(before);
    // Another Bun version: repointed.
    const second = verbsDir();
    await refreshCheckoutBun(root, bun, second);
    expect(readlinkSync(link)).toBe(second);
  });

  test("an older build's hardlinked bun becomes a clone; per-checkout verb names go", async () => {
    const root = asAppPath(mkdtempSync(join(tmpdir(), "process-name-")));
    const bun = fakeBin(root);
    const dir = join(root, CHECKOUT_BUN_DIR);
    mkdirSync(dir, { recursive: true });
    linkSync(bun, join(dir, "bun"));
    linkSync(bun, join(dir, "equin · run · att-x"));
    linkSync(bun, join(dir, "equin · test · att-x.4242"));
    await refreshCheckoutBun(root, bun, verbsDir());
    expect(statSync(join(dir, "bun")).nlink).toBe(1);
    expect(existsSync(join(dir, "equin · run · att-x"))).toBe(false);
    // A script's clone in flight is its own business.
    expect(statSync(join(dir, "equin · test · att-x.4242")).ino).toBe(
      statSync(bun).ino,
    );
  });
});
