import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainAddresses, servedGraphOf } from "./address-retention";

const tmp = mkdtempSync(join(tmpdir(), "address-retention-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 11, 12);
let n = 0;

function fixture(): { store: string; addressDir: string; graphsDir: string } {
  const root = join(tmp, String(n++));
  const f = {
    store: join(root, "store"),
    addressDir: join(root, "web-addresses"),
    graphsDir: join(root, "web-graphs"),
  };
  mkdirSync(f.store, { recursive: true });
  mkdirSync(f.addressDir, { recursive: true });
  return f;
}

/** Link `names` into the address dir, as compose does. */
function link(f: { store: string; addressDir: string }, names: string[]): void {
  for (const name of names) {
    mkdirSync(join(f.store, name), { recursive: true });
    if (!existsSync(join(f.addressDir, name))) {
      symlinkSync(join(f.store, name), join(f.addressDir, name));
    }
  }
}

const linked = (dir: string): string[] => readdirSync(dir).sort();

describe("retainAddresses", () => {
  test("keeps the composed and served graphs, drops what only an old graph needed", () => {
    const f = fixture();
    link(f, ["a", "b"]);
    retainAddresses({
      ...f,
      graph: "g1",
      names: ["a", "b"],
      live: null,
      now: T0,
    });
    link(f, ["a", "c"]);
    retainAddresses({
      ...f,
      graph: "g2",
      names: ["a", "c"],
      live: { graph: "g1", names: ["a", "b"] },
      now: T0 + HOUR,
    });
    expect(linked(f.addressDir)).toEqual(["a", "b", "c"]);

    // A day later g1 is neither served nor needed: b goes, the store stays.
    link(f, ["a", "d"]);
    const r = retainAddresses({
      ...f,
      graph: "g3",
      names: ["a", "d"],
      live: { graph: "g2", names: ["a", "c"] },
      now: T0 + 26 * HOUR,
    });
    expect(linked(f.addressDir)).toEqual(["a", "c", "d"]);
    expect(r.removed).toBe(1);
    expect(existsSync(join(f.store, "b"))).toBe(true);
    expect(linked(f.graphsDir)).toEqual(["g2.names", "g3.names", "index.json"]);
  });

  test("the served graph stays whatever its age (a failed deploy reverts to it)", () => {
    const f = fixture();
    link(f, ["old"]);
    retainAddresses({ ...f, graph: "g1", names: ["old"], live: null, now: T0 });
    link(f, ["new"]);
    retainAddresses({
      ...f,
      graph: "g2",
      names: ["new"],
      live: { graph: "g1", names: ["old"] },
      now: T0 + 30 * 24 * HOUR,
    });
    expect(linked(f.addressDir)).toEqual(["new", "old"]);
  });

  test("a graph an open tab touched stays; only touched records are re-read", () => {
    const f = fixture();
    link(f, ["a", "tabOnly"]);
    retainAddresses({
      ...f,
      graph: "g1",
      names: ["a", "tabOnly"],
      live: null,
      now: T0,
    });
    link(f, ["a"]);
    retainAddresses({
      ...f,
      graph: "g2",
      names: ["a"],
      live: { graph: "g1", names: ["a", "tabOnly"] },
      now: T0 + HOUR,
    });
    // The backend touches g1's record: a tab still runs it.
    const touched = new Date(T0 + 20 * HOUR);
    utimesSync(join(f.graphsDir, "g1.names"), touched, touched);
    const r = retainAddresses({
      ...f,
      graph: "g3",
      names: ["a"],
      live: { graph: "g2", names: ["a"] },
      now: T0 + 30 * HOUR,
    });
    expect(linked(f.addressDir)).toEqual(["a", "tabOnly"]);
    // g1 (touched) is re-read; g2 (stamped as live) and g3 (new) too.
    expect(r.recordsRead).toBe(3);

    // An unchanged run reads only the two records it stamps itself.
    const again = retainAddresses({
      ...f,
      graph: "g3",
      names: ["a"],
      live: { graph: "g3", names: ["a"] },
      now: T0 + 30 * HOUR + 1,
    });
    expect(again.recordsRead).toBe(1);
  });

  test("the first trim ages existing links by when they were linked", () => {
    const f = fixture();
    link(f, ["ancient", "recent", "current"]);
    const ancient = new Date(T0 - 5 * 24 * HOUR);
    lutimesSync(join(f.addressDir, "ancient"), ancient, ancient);
    const recent = new Date(T0 - 2 * HOUR);
    lutimesSync(join(f.addressDir, "recent"), recent, recent);
    const r = retainAddresses({
      ...f,
      graph: "g1",
      names: ["current"],
      live: null,
      now: T0,
    });
    expect(r.migrated).toBe(true);
    expect(linked(f.addressDir)).toEqual(["current", "recent"]);
  });
});

describe("servedGraphOf", () => {
  test("reads a dist composed before graph records off its page and root links", () => {
    const root = join(tmp, String(n++));
    const dist = join(root, "web");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, ".build-graph"), "abc123\n");
    writeFileSync(
      join(dist, "index.html"),
      `<script type="importmap">{"imports":{"x":"/artifacts/p.web.1/index.js"}}</script>` +
        `<link rel="modulepreload" href="/artifacts/set.2/react.js" />` +
        `<script type="module" src="/artifacts/entry.3/index.js"></script>`,
    );
    symlinkSync(
      "artifacts/site.crawl-snapshot.4/snapshot",
      join(dist, "snapshot"),
    );
    const got = servedGraphOf({
      distDir: dist,
      graphsDir: join(root, "web-graphs"),
    });
    expect(got?.graph).toBe("abc123");
    expect([...(got?.names ?? [])].sort()).toEqual([
      "entry.3",
      "p.web.1",
      "set.2",
      "site.crawl-snapshot.4",
    ]);
  });

  test("no served dist: null", () => {
    const root = join(tmp, String(n++));
    expect(
      servedGraphOf({ distDir: join(root, "web"), graphsDir: join(root, "g") }),
    ).toBeNull();
  });
});
