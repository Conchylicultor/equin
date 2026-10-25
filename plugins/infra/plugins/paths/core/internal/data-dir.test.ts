import {
  readEnv,
  setEnv,
  unsetEnv,
  type EnvKey,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { afterAll, afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declareRuntimeNamespace,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";
import { resetRuntimeNamespaceForTest } from "@plugins/infra/plugins/runtime-identity/core/testing";
import {
  dataRoot,
  defineAppDataDir,
  defineDataDir,
  getDataDirs,
  isDataDir,
  mayMoveSharedData,
} from "./data-dir";

// `defineDataDir`'s registry is module-global and never cleared — that is the
// point of its exactly-once discipline — so every test below uses a fixture name
// unique to itself. Two tests sharing a name would collide through the registry
// rather than through anything they assert.

// Every variable a test below rewrites, plus the process's declared runtime
// namespace. The move tests impersonate a process that may or may not move
// shared data, and that is decided by the declared namespace and
// `EQUIN_RELEASE`. The `bun test` preload declared this process's
// namespace as the checkout it runs from, so each test puts that exact
// declaration back rather than merely dropping it.
const ENV_KEYS: readonly EnvKey[] = ["DIR", "RELEASE"];
const ORIGINAL_ENV = new Map<EnvKey, string | undefined>(
  ENV_KEYS.map((k) => [k, readEnv(k)] as const),
);
const ORIGINAL_NAMESPACE = runtimeNamespace();

function restoreEnv(): void {
  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) unsetEnv(key);
    else setEnv(key, value);
  }
  resetRuntimeNamespaceForTest();
  declareRuntimeNamespace(ORIGINAL_NAMESPACE);
}

afterEach(restoreEnv);
afterAll(restoreEnv);

const spec = (name: string) =>
  ({
    kind: "cache",
    name,
    owner: "infra/paths",
    description: "test fixture",
    reclaim: { kind: "safe" },
  }) as const;

test("a duplicate kind/name throws rather than returning the first", () => {
  defineDataDir(spec("dup-fixture"));
  expect(() => defineDataDir(spec("dup-fixture"))).toThrow(/already declared/);
});

test("the same name under a DIFFERENT kind is a different directory", () => {
  const cache = defineDataDir(spec("two-kinds"));
  const locks = defineDataDir({ ...spec("two-kinds"), kind: "locks" });
  expect(cache.path).not.toBe(locks.path);
});

test("an invalid name throws", () => {
  for (const bad of [
    "Caps",
    "-leading",
    "has/slash",
    "has space",
    "",
    "..",
    "under_score",
  ]) {
    expect(() => defineDataDir(spec(bad))).toThrow(/name must match/);
  }
});

test("path resolves lazily against the CURRENT data-root variable, not the one at declaration", () => {
  setEnv("DIR", "/tmp/root-a");
  const dir = defineDataDir(spec("lazy-fixture"));
  expect(dir.path).toBe(join("/tmp/root-a", "cache", "lazy-fixture"));

  // The launcher's move: the root changes AFTER the declaration ran.
  setEnv("DIR", "/tmp/root-b");
  expect(dir.path).toBe(join("/tmp/root-b", "cache", "lazy-fixture"));
  expect(dir.file("sub", "f.json")).toBe(
    join("/tmp/root-b", "cache", "lazy-fixture", "sub", "f.json"),
  );
  expect(dataRoot()).toBe("/tmp/root-b");
});

test("legacyLocation resolves relative to the root, outside its kind", () => {
  setEnv("DIR", "/tmp/root-c");
  const dir = defineDataDir({
    ...spec("legacy-fixture"),
    kind: "services",
    legacyLocation: {
      path: "postgres",
      reason: "moving it needs cluster downtime",
    },
  });
  expect(dir.path).toBe(join("/tmp/root-c", "postgres"));
  // Still lazy — the override is a relative segment, never a frozen absolute.
  setEnv("DIR", "/tmp/root-d");
  expect(dir.path).toBe(join("/tmp/root-d", "postgres"));
});

test("getDataDirs returns a copy, keyed by kind/name", () => {
  defineDataDir(spec("copy-fixture"));
  const first = getDataDirs();
  const second = getDataDirs();
  expect(first).not.toBe(second);
  expect(first.get("cache/copy-fixture")?.spec.name).toBe("copy-fixture");
});

test("ensure() creates the directory and returns it", () => {
  const root = mkdtempSync(join(tmpdir(), "data-dir-ensure-"));
  setEnv("DIR", root);
  const dir = defineDataDir(spec("ensure-fixture"));
  expect(dir.ensure()).toBe(join(root, "cache", "ensure-fixture"));
  // Idempotent: a second call on an existing directory is a no-op, not a throw.
  expect(dir.ensure()).toBe(join(root, "cache", "ensure-fixture"));
});

test("ensure() throws when the target exists and is NOT a directory", () => {
  // The trap this guard exists for: several root entries are loose FILES today
  // (`duress.latch`, `gateway.pid`, the `*.jsonl` sinks). Pointing a
  // declaration's `legacyLocation` at one of those would otherwise try to mkdir
  // over the file, and the owner's next write would fail with EISDIR far from
  // the declaration that caused it.
  const root = mkdtempSync(join(tmpdir(), "data-dir-notdir-"));
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(join(root, "some.latch"), "held");
  setEnv("DIR", root);

  const dir = defineDataDir({
    ...spec("notdir-fixture"),
    kind: "logs",
    legacyLocation: { path: "some.latch", reason: "loose file at the root" },
  });

  expect(() => dir.ensure()).toThrow(/is NOT a directory/);
});

test("isDataDir accepts a real declaration and rejects a shape without subdir()", () => {
  const dir = defineDataDir(spec("isdatadir-fixture"));
  expect(isDataDir(dir)).toBe(true);
  expect(
    isDataDir({ spec: dir.spec, file: dir.file, ensure: dir.ensure }),
  ).toBe(false);
});

// ── defineAppDataDir: one dir per app ────────────────────────────────────────

const appOpts = (owner: string) => ({
  owner,
  description: "test fixture app content",
});

test("defineAppDataDir derives the name from the app id, under apps/, never reclaimable", () => {
  setEnv("DIR", "/tmp/root-app");
  // Shaped like an `AppRef` — the parameter is structural, so a real app's ref
  // passes as-is without this plugin depending on the pane primitive.
  const app = { id: "fixture-app-derive", name: "Fixture", basePath: "/x" };
  const dir = defineAppDataDir(app, appOpts("apps/fixture-app-derive"));
  expect(dir.spec.kind).toBe("apps");
  expect(dir.spec.name).toBe("fixture-app-derive");
  expect(dir.spec.reclaim.kind).toBe("never");
  expect(dir.path).toBe(join("/tmp/root-app", "apps", "fixture-app-derive"));
  expect(getDataDirs().get("apps/fixture-app-derive")).toBe(dir);
});

test("a second data dir for the same app throws, and says to use subdir() instead", () => {
  defineAppDataDir({ id: "fixture-app-dup" }, appOpts("apps/fixture-app-dup"));
  // What the prototype-history agent would have hit: a sub-plugin reaching for
  // a whole directory when it wanted an area of the app's one.
  const second = () =>
    defineAppDataDir(
      { id: "fixture-app-dup" },
      {
        owner: "apps/fixture-app-dup/history",
        description: "per-prototype version history",
      },
    );
  expect(second).toThrow(
    'app "fixture-app-dup" already owns its data dir (apps/fixture-app-dup, declared by apps/fixture-app-dup)',
  );
  expect(second).toThrow('put "per-prototype version history" inside it');
  expect(second).toThrow('fixtureAppDupDir.subdir("<area-name>")');
});

test("an app id that is not a valid data-dir name throws", () => {
  for (const bad of ["Caps", "has/slash", "", "under_score"])
    expect(() =>
      defineAppDataDir({ id: bad }, appOpts("apps/whatever")),
    ).toThrow(/app id must match/);
});

test("defineDataDir refuses the apps kind — a type error, and a throw for a caller that got past it", () => {
  expect(() =>
    defineDataDir({
      // @ts-expect-error — an apps/* dir is spelled only through defineAppDataDir
      kind: "apps",
      name: "fixture-apps-via-define",
      owner: "infra/paths",
      description: "test fixture",
      reclaim: { kind: "never", reason: "test" },
    }),
  ).toThrow(/defineAppDataDir/);
  expect(getDataDirs().has("apps/fixture-apps-via-define")).toBe(false);
});

// ── subdir: an area inside a declared dir ────────────────────────────────────

test("subdir() names an area inside the dir: path, file() and ensure()", () => {
  const root = mkdtempSync(join(tmpdir(), "data-dir-subdir-"));
  setEnv("DIR", root);
  const dir = defineAppDataDir(
    { id: "fixture-subdir-app" },
    appOpts("apps/fixture-subdir-app"),
  );
  const area = dir.subdir("history");
  const expected = join(root, "apps", "fixture-subdir-app", "history");
  expect(area.path).toBe(expected);
  expect(area.file("p1", "log.json")).toBe(join(expected, "p1", "log.json"));
  expect(area.ensure()).toBe(expected);
  expect(lstatSync(expected).isDirectory()).toBe(true);
  // Not a declaration: the registry holds the app dir and nothing more.
  expect(getDataDirs().has("apps/history")).toBe(false);
});

test("subdir() rejects anything but one lowercase segment", () => {
  const dir = defineDataDir(spec("subdir-bad-names"));
  for (const bad of ["a/b", "..", "", "Caps", "_history"])
    expect(() => dir.subdir(bad)).toThrow(/must match/);
});

test("an area's ensure() shares the not-a-directory guard", () => {
  const root = mkdtempSync(join(tmpdir(), "data-dir-area-notdir-"));
  setEnv("DIR", root);
  const dir = defineDataDir(spec("area-notdir"));
  mkdirSync(dir.path, { recursive: true });
  writeFileSync(dir.file("blob"), "a file, not an area");
  expect(() => dir.subdir("blob").ensure()).toThrow(/is NOT a directory/);
});

// ── movedFrom ────────────────────────────────────────────────────────────────

/** A process that may NOT move shared data: no runtime namespace, not a release. */
function asOrdinaryProcess(): void {
  resetRuntimeNamespaceForTest();
  unsetEnv("RELEASE");
}

/**
 * A process that MAY: a release's single backend. The main-backend arm also
 * requires running from the main checkout, which a test in a linked worktree
 * cannot be — that arm is covered by the `mayMoveSharedData` truth table below.
 */
function asMover(): void {
  setEnv("RELEASE", "1");
}

function freshRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `data-dir-move-${label}-`));
  setEnv("DIR", root);
  return root;
}

test("movedFrom on a fresh root (neither location exists) resolves to the new location", () => {
  const root = freshRoot("fresh");
  asMover();
  const dir = defineDataDir({
    ...spec("move-fresh"),
    kind: "state",
    reclaim: { kind: "never", reason: "test" },
    movedFrom: [{ from: "apps/move-fresh-old" }],
  });
  expect(dir.path).toBe(join(root, "state", "move-fresh"));
  expect(existsSync(join(root, "apps", "move-fresh-old"))).toBe(false);
});

test("a pending move, in a process that may not move, resolves to the OLD location and moves nothing", () => {
  const root = freshRoot("pending-ordinary");
  const old = join(root, "apps", "move-pending-old");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "a.bin"), "bytes");
  asOrdinaryProcess();

  const dir = defineDataDir({
    ...spec("move-pending"),
    kind: "state",
    reclaim: { kind: "never", reason: "test" },
    movedFrom: [{ from: "apps/move-pending-old" }],
  });
  expect(dir.path).toBe(old);
  expect(dir.file("a.bin")).toBe(join(old, "a.bin"));
  expect(dir.ensure()).toBe(old);
  expect(dir.subdir("sub").path).toBe(join(old, "sub"));
  // Nothing moved, nothing created at the new spot.
  expect(lstatSync(old).isDirectory()).toBe(true);
  expect(existsSync(join(root, "state", "move-pending"))).toBe(false);

  // Not memoized: the moment the move happens elsewhere, reads follow it.
  asMover();
  expect(dir.path).toBe(join(root, "state", "move-pending"));
});

test("a pending move, in the process that may move, renames and plants a relative symlink — once", () => {
  const root = freshRoot("pending-mover");
  const old = join(root, "apps", "move-mover-old");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "a.bin"), "bytes");
  asMover();

  const dir = defineDataDir({
    ...spec("move-mover"),
    kind: "state",
    reclaim: { kind: "never", reason: "test" },
    movedFrom: [{ from: "apps/move-mover-old" }],
  });
  const dest = join(root, "state", "move-mover");
  expect(dir.path).toBe(dest);
  expect(readFileSync(join(dest, "a.bin"), "utf8")).toBe("bytes");
  expect(lstatSync(old).isSymbolicLink()).toBe(true);
  expect(readlinkSync(old)).toBe(join("..", "state", "move-mover"));
  // The old path now reaches the same bytes — what an older checkout reads.
  expect(readFileSync(join(old, "a.bin"), "utf8")).toBe("bytes");

  // A second resolution is a no-op, in this process or any other.
  expect(dir.file("a.bin")).toBe(join(dest, "a.bin"));
  asOrdinaryProcess();
  expect(dir.path).toBe(dest);
});

test("a split copy (old is a real dir AND the destination exists) throws, for every process", () => {
  const root = freshRoot("conflict");
  mkdirSync(join(root, "apps", "move-conflict-old"), { recursive: true });
  mkdirSync(join(root, "state", "move-conflict"), { recursive: true });
  const dir = defineDataDir({
    ...spec("move-conflict"),
    kind: "state",
    reclaim: { kind: "never", reason: "test" },
    movedFrom: [{ from: "apps/move-conflict-old" }],
  });
  asOrdinaryProcess();
  expect(() => dir.path).toThrow(/SPLIT COPY/);
  asMover();
  expect(() => dir.ensure()).toThrow(/SPLIT COPY/);
  // And nothing was touched trying.
  expect(lstatSync(join(root, "apps", "move-conflict-old")).isDirectory()).toBe(
    true,
  );
});

test("an area move (`to`) redirects only that area, and creates the destination's parent", () => {
  const root = freshRoot("area");
  const old = join(root, "apps", "fixture-old-wallpaper");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "w.jpg"), "pixels");
  const desktop = defineAppDataDir(
    { id: "fixture-area-desktop" },
    {
      ...appOpts("apps-core"),
      movedFrom: [{ from: "apps/fixture-old-wallpaper", to: "wallpaper" }],
    },
  );
  const home = join(root, "apps", "fixture-area-desktop");

  asOrdinaryProcess();
  // The dir itself and every OTHER area are the new location from day one…
  expect(desktop.path).toBe(home);
  expect(desktop.file("other", "x")).toBe(join(home, "other", "x"));
  // …while the moved area still reads its bytes where they are.
  expect(desktop.subdir("wallpaper").path).toBe(old);
  expect(desktop.file("wallpaper", "w.jpg")).toBe(join(old, "w.jpg"));
  expect(desktop.file("wallpaper/w.jpg")).toBe(join(old, "w.jpg"));
  expect(existsSync(home)).toBe(false);

  asMover();
  const area = desktop.subdir("wallpaper");
  expect(area.file("w.jpg")).toBe(join(home, "wallpaper", "w.jpg"));
  expect(readFileSync(join(home, "wallpaper", "w.jpg"), "utf8")).toBe("pixels");
  expect(readlinkSync(old)).toBe(join("fixture-area-desktop", "wallpaper"));
});

test("a settled move is memoized per data root; a different root is inspected afresh", () => {
  const first = freshRoot("memo-a");
  asMover();
  const dir = defineDataDir({
    ...spec("move-memo"),
    kind: "state",
    reclaim: { kind: "never", reason: "test" },
    movedFrom: [{ from: "apps/move-memo-old" }],
  });
  expect(dir.path).toBe(join(first, "state", "move-memo")); // fresh ⇒ settled

  // Once settled on this root, reads no longer stat the old location at all —
  // even a split copy appearing later is not re-inspected here (the audit and a
  // restart see it; the steady-state read path pays nothing).
  mkdirSync(join(first, "apps", "move-memo-old"), { recursive: true });
  mkdirSync(join(first, "state", "move-memo"), { recursive: true });
  expect(dir.path).toBe(join(first, "state", "move-memo"));

  // A different root has its own answer: pending there, so an ordinary process
  // reads the old location.
  const second = freshRoot("memo-b");
  mkdirSync(join(second, "apps", "move-memo-old"), { recursive: true });
  asOrdinaryProcess();
  expect(dir.path).toBe(join(second, "apps", "move-memo-old"));
});

test("only the host singleton running merged code may move shared data", () => {
  // The main backend, from the main checkout.
  expect(
    mayMoveSharedData({
      hostSingleton: true,
      release: false,
      mainCheckout: true,
    }),
  ).toBe(true);
  // A release's single backend: its own root, no checkout at all.
  expect(
    mayMoveSharedData({
      hostSingleton: true,
      release: true,
      mainCheckout: false,
    }),
  ).toBe(true);
  // THE case this rule exists for: a process that reads as the host singleton
  // (main's backend spawned it, or a leaked identity once made every agent CLI
  // read as main) but runs an UNMERGED branch from a linked worktree — it must
  // never move bytes on the root every checkout shares.
  expect(
    mayMoveSharedData({
      hostSingleton: true,
      release: false,
      mainCheckout: false,
    }),
  ).toBe(false);
  // A worktree backend, or a hand-run CLI.
  expect(
    mayMoveSharedData({
      hostSingleton: false,
      release: false,
      mainCheckout: true,
    }),
  ).toBe(false);
  expect(
    mayMoveSharedData({
      hostSingleton: false,
      release: false,
      mainCheckout: false,
    }),
  ).toBe(false);
});

test("a malformed movedFrom throws at declaration, naming the owner", () => {
  const base = {
    ...spec("move-malformed"),
    kind: "state" as const,
    reclaim: { kind: "never" as const, reason: "test" },
  };
  expect(() =>
    defineDataDir({
      ...base,
      name: "move-malformed-a",
      // @ts-expect-error — not a data-dir ref at all
      movedFrom: [{ from: "nowhere" }],
    }),
  ).toThrow(/must be a "<kind>\/<name>" data-dir ref/);
  expect(() =>
    defineDataDir({
      ...base,
      name: "move-malformed-b",
      movedFrom: [{ from: "apps/a/b" }],
    }),
  ).toThrow(/data-dir ref/);
  expect(() =>
    defineDataDir({
      ...base,
      name: "move-malformed-c",
      movedFrom: [{ from: "apps/move-malformed-c-old", to: "a/b" }],
    }),
  ).toThrow(/movedFrom.to must match/);
  expect(() =>
    defineDataDir({
      ...base,
      name: "move-malformed-d",
      movedFrom: [
        { from: "apps/move-malformed-d-1" },
        { from: "apps/move-malformed-d-2", to: "x" },
      ],
    }),
  ).toThrow(/mixes a whole-directory movedFrom/);
  expect(() =>
    defineDataDir({
      ...base,
      name: "move-malformed-e",
      legacyLocation: { path: "somewhere", reason: "test" },
      movedFrom: [{ from: "apps/move-malformed-e-old" }],
    }),
  ).toThrow(/both legacyLocation and movedFrom/);
});

test("an old location moves to exactly one place, and cannot still be declared", () => {
  const base = {
    ...spec("move-claims"),
    kind: "state" as const,
    reclaim: { kind: "never" as const, reason: "test" },
  };
  defineDataDir({
    ...base,
    name: "move-claims-a",
    movedFrom: [{ from: "apps/move-claims-old" }],
  });
  expect(() =>
    defineDataDir({
      ...base,
      name: "move-claims-b",
      movedFrom: [{ from: "apps/move-claims-old" }],
    }),
  ).toThrow(/both record that apps\/move-claims-old moved/);

  // Declared first, then claimed as moved away …
  defineDataDir({ ...base, kind: "cache", name: "move-claims-live" });
  expect(() =>
    defineDataDir({
      ...base,
      name: "move-claims-c",
      movedFrom: [{ from: "cache/move-claims-live" }],
    }),
  ).toThrow(/is still declared/);
  // … and claimed as moved away, then declared.
  defineDataDir({
    ...base,
    name: "move-claims-d",
    movedFrom: [{ from: "cache/move-claims-gone" }],
  });
  expect(() =>
    defineDataDir({ ...base, kind: "cache", name: "move-claims-gone" }),
  ).toThrow(/records that it moved away/);
});
