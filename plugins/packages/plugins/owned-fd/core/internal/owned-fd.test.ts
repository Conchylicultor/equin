import { afterAll, describe, expect, test } from "bun:test";
import { fstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { adoptFd, FdAlreadyClosedError, openOwnedFdSync } from "./owned-fd";

const dir = asAppPath(mkdtempSync(join(tmpdir(), "owned-fd-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("OwnedFd", () => {
  test("closes its descriptor exactly once; the second close throws and never reaches the kernel", () => {
    const a = openOwnedFdSync(asAppPath(join(dir, "a")), "w");
    expect(a.closed).toBe(false);
    a.close();
    expect(a.closed).toBe(true);

    // Something else may hold the number by now — the reuse that made a
    // second raw close fatal to an innocent resource.
    const b = openOwnedFdSync(asAppPath(join(dir, "b")), "w");

    let err: unknown;
    try {
      a.close();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FdAlreadyClosedError);
    expect((err as FdAlreadyClosedError).fd).toBe(a.fd);
    expect((err as FdAlreadyClosedError).firstClosedAt).toContain(
      "owned-fd.test.ts",
    );
    // What holds a number now survived the double close.
    expect(() => fstatSync(b.fd)).not.toThrow();
    b.close();
  });

  test("refuses a number that is not a descriptor", () => {
    expect(() => adoptFd(-1)).toThrow(RangeError);
    expect(() => adoptFd(1.5)).toThrow(RangeError);
  });

  test("a close the kernel refuses still spends the handle", () => {
    // A number far above any this process has open: the kernel answers EBADF,
    // and no live descriptor is touched.
    const owned = adoptFd(1_000_000);
    expect(() => owned.close()).toThrow();
    expect(owned.closed).toBe(true);
    expect(() => owned.close()).toThrow(FdAlreadyClosedError);
  });
});
