import { describe, expect, test } from "bun:test";
import {
  absolutePath,
  baseName,
  displayPath,
  isWithin,
  joinPath,
  parentPath,
  pathChain,
} from "./paths";
import { decodeOpenParam, encodeOpenParam } from "./location";
import { formatCount, formatModified, formatSize } from "./format";

const HOME_ABS = "/h/me";

describe("paths", () => {
  test("join at the root and below", () => {
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("~", "Downloads")).toBe("~/Downloads");
    expect(joinPath("/h/me", "x")).toBe("/h/me/x");
  });

  test("base names", () => {
    expect(baseName("~")).toBe("~");
    expect(baseName("/")).toBe("/");
    expect(baseName("~/Projects/equin")).toBe("equin");
  });

  test("parent keeps the form, and home's parent is absolute", () => {
    expect(parentPath("~/Projects/x", HOME_ABS)).toBe("~/Projects");
    expect(parentPath("~/Projects", HOME_ABS)).toBe("~");
    expect(parentPath("~", HOME_ABS)).toBe("/h");
    expect(parentPath("/h", HOME_ABS)).toBe("/");
    expect(parentPath("/", HOME_ABS)).toBeNull();
  });

  test("tilde expansion and collapse round-trip", () => {
    expect(absolutePath("~/a", HOME_ABS)).toBe("/h/me/a");
    expect(absolutePath("~", HOME_ABS)).toBe(HOME_ABS);
    expect(displayPath("/h/me/a", HOME_ABS)).toBe("~/a");
    expect(displayPath("/h/me", HOME_ABS)).toBe("~");
    expect(displayPath("/h/meow", HOME_ABS)).toBe("/h/meow");
    expect(displayPath("~/a", HOME_ABS)).toBe("~/a");
  });

  test("within", () => {
    expect(isWithin("~/a/b", "~/a")).toBe(true);
    expect(isWithin("~/ab", "~/a")).toBe(false);
    expect(isWithin("/etc", "/")).toBe(true);
  });

  test("chain of crumbs", () => {
    expect(pathChain("~/Projects/x")).toEqual([
      "~",
      "~/Projects",
      "~/Projects/x",
    ]);
    expect(pathChain("/usr/bin")).toEqual(["/", "/usr", "/usr/bin"]);
    expect(pathChain("/")).toEqual(["/"]);
  });
});

describe("open param", () => {
  test("a file of the folder is written relative to it", () => {
    expect(encodeOpenParam("~/p", "~/p/a/README.md")).toBe("a/README.md");
    expect(decodeOpenParam("~/p", "a/README.md")).toBe("~/p/a/README.md");
    expect(encodeOpenParam("/", "/etc/hosts")).toBe("etc/hosts");
    expect(decodeOpenParam("/", "etc/hosts")).toBe("/etc/hosts");
  });

  test("a file elsewhere keeps its full path", () => {
    expect(encodeOpenParam("~/p", "~/q/x")).toBe("~/q/x");
    expect(decodeOpenParam("~/p", "~/q/x")).toBe("~/q/x");
    expect(decodeOpenParam("~/p", "/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("format", () => {
  test("decimal sizes", () => {
    expect(formatSize(900)).toBe("900 B");
    expect(formatSize(3400)).toBe("3.4 KB");
    expect(formatSize(24_000)).toBe("24 KB");
    expect(formatSize(1_200_000)).toBe("1.2 MB");
    expect(formatSize(182_000_000)).toBe("182 MB");
    expect(formatSize(4_400_000_000)).toBe("4.4 GB");
  });

  test("counts", () => {
    expect(formatCount(1)).toBe("1 item");
    expect(formatCount(3)).toBe("3 items");
  });

  test("modified, by local calendar day", () => {
    const now = new Date(2026, 9, 2, 15, 0).getTime();
    expect(formatModified(new Date(2026, 9, 2, 0, 5).getTime(), now)).toBe(
      "Today",
    );
    expect(formatModified(new Date(2026, 9, 1, 23, 59).getTime(), now)).toBe(
      "Yesterday",
    );
    expect(formatModified(new Date(2026, 8, 28).getTime(), now, "en-US")).toBe(
      "Sep 28",
    );
    expect(formatModified(new Date(2025, 8, 28).getTime(), now, "en-US")).toBe(
      "Sep 28, 2025",
    );
  });
});
