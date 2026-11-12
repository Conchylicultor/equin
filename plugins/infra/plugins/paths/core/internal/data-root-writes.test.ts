import { describe, expect, test } from "bun:test";
import { dataRootWriteViolationSync } from "./data-root-writes";
import { legacyRootEntries } from "./legacy-layout";

const ROOT = "/h/.equin";
const LEGACY = "/h/.legacy";
const existing = new Set([`${ROOT}/apps/prototypes`, `${ROOT}/cache/check`]);
const v = (p: string) =>
  dataRootWriteViolationSync(p, {
    roots: [ROOT, LEGACY],
    existsSync: (x) => existing.has(x),
    declaredRootEntriesSync: () => new Set(["postgres", "sockets"]),
  });

describe("dataRootWriteViolationSync", () => {
  test("a top-level entry that is not a kind is a violation", () => {
    expect(v(`${ROOT}/demo-audit-2026-11-10/a.png`)).toEqual({
      kind: "root-entry",
      entry: "demo-audit-2026-11-10",
    });
    expect(v(`${ROOT}/tmp-probe-1.png`)).toEqual({
      kind: "root-entry",
      entry: "tmp-probe-1.png",
    });
    expect(v(`${LEGACY}/stray`)).toEqual({
      kind: "root-entry",
      entry: "stray",
    });
  });

  test("a kind child that does not exist is a violation; one that does is not", () => {
    expect(v(`${ROOT}/cache/shots/a.png`)).toEqual({
      kind: "kind-child",
      entry: "cache/shots",
    });
    expect(v(`${ROOT}/cache/check/x.json`)).toBeNull();
    expect(v(`${ROOT}/apps/prototypes/p/index.html`)).toBeNull();
    expect(v(`${ROOT}/cache`)).toBeNull();
    expect(v(`${ROOT}/deprecated/anything`)).toBeNull();
    expect(v(`${ROOT}/worktrees/att-1/x`)).toBeNull();
  });

  test("a grandfathered service a declaration owns passes", () => {
    expect(v(`${ROOT}/sockets/x.sock`)).toBeNull();
    expect(v(`${ROOT}/postgres/socket`)).toBeNull();
  });

  test("legacy shim names pass; drained names do not", () => {
    for (const e of legacyRootEntries()) {
      const shim = e.expect.kind === "symlink" || e.expect.kind === "kind-dir";
      expect(v(`${ROOT}/${e.name}`) === null).toBe(shim);
    }
  });

  test("the root itself and paths outside it are not asked about", () => {
    expect(v(`${ROOT}/`)).toBeNull();
    expect(v(ROOT)).toBeNull();
    expect(v("/h/.equinx/a")).toBeNull();
    expect(v("/tmp/x")).toBeNull();
  });
});
