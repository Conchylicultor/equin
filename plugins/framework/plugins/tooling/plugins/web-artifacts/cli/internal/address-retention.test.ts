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

type RetainOpts = Omit<
  Parameters<typeof retainAddresses>[0],
  "addressDir" | "graphsDir" | "now"
>;

/**
 * One namespace's dirs and ONE clock: `link` stamps each new link at the
 * clock's time, as compose would have, and `retain` trims at the same time —
 * so no age compares the test's instant with a file's real mtime.
 */
function fixture(start = T0) {
  const root = join(tmp, String(n++));
  const store = join(root, "store");
  const addressDir = join(root, "web-addresses");
  const graphsDir = join(root, "web-graphs");
  mkdirSync(store, { recursive: true });
  mkdirSync(addressDir, { recursive: true });
  let now = start;
  return {
    store,
    addressDir,
    graphsDir,
    /** Move the clock to `t`. */
    at(t: number): void {
      now = t;
    },
    /** Link `names` into the address dir, as compose does, at the clock's time. */
    link(names: string[]): void {
      const t = new Date(now);
      for (const name of names) {
        mkdirSync(join(store, name), { recursive: true });
        const path = join(addressDir, name);
        if (existsSync(path)) continue;
        symlinkSync(join(store, name), path);
        lutimesSync(path, t, t);
      }
    },
    retain(opts: RetainOpts) {
      return retainAddresses({ addressDir, graphsDir, ...opts, now });
    },
  };
}

const linked = (dir: string): string[] => readdirSync(dir).sort();

describe("retainAddresses", () => {
  test("keeps the composed and served graphs, drops what only an old graph needed", () => {
    const f = fixture();
    f.link(["a", "b"]);
    f.retain({ graph: "g1", names: ["a", "b"], live: null });
    f.at(T0 + HOUR);
    f.link(["a", "c"]);
    f.retain({
      graph: "g2",
      names: ["a", "c"],
      live: { graph: "g1", names: ["a", "b"] },
    });
    expect(linked(f.addressDir)).toEqual(["a", "b", "c"]);

    // A day later g1 is neither served nor needed: b goes, the store stays.
    f.at(T0 + 26 * HOUR);
    f.link(["a", "d"]);
    const r = f.retain({
      graph: "g3",
      names: ["a", "d"],
      live: { graph: "g2", names: ["a", "c"] },
    });
    expect(linked(f.addressDir)).toEqual(["a", "c", "d"]);
    expect(r.removed).toBe(1);
    expect(existsSync(join(f.store, "b"))).toBe(true);
    expect(linked(f.graphsDir)).toEqual(["g2.names", "g3.names", "index.json"]);
  });

  test("the served graph stays whatever its age (a failed deploy reverts to it)", () => {
    const f = fixture();
    f.link(["old"]);
    f.retain({ graph: "g1", names: ["old"], live: null });
    f.at(T0 + 30 * 24 * HOUR);
    f.link(["new"]);
    f.retain({
      graph: "g2",
      names: ["new"],
      live: { graph: "g1", names: ["old"] },
    });
    expect(linked(f.addressDir)).toEqual(["new", "old"]);
  });

  test("a graph an open tab touched stays; only touched records are re-read", () => {
    const f = fixture();
    f.link(["a", "tabOnly"]);
    f.retain({ graph: "g1", names: ["a", "tabOnly"], live: null });
    f.at(T0 + HOUR);
    f.link(["a"]);
    f.retain({
      graph: "g2",
      names: ["a"],
      live: { graph: "g1", names: ["a", "tabOnly"] },
    });
    // The backend touches g1's record: a tab still runs it.
    const touched = new Date(T0 + 20 * HOUR);
    utimesSync(join(f.graphsDir, "g1.names"), touched, touched);
    f.at(T0 + 30 * HOUR);
    const r = f.retain({
      graph: "g3",
      names: ["a"],
      live: { graph: "g2", names: ["a"] },
    });
    expect(linked(f.addressDir)).toEqual(["a", "tabOnly"]);
    // g1 (touched) is re-read; g2 (stamped as live) and g3 (new) too.
    expect(r.recordsRead).toBe(3);

    // An unchanged run reads only the two records it stamps itself.
    f.at(T0 + 30 * HOUR + 1);
    const again = f.retain({
      graph: "g3",
      names: ["a"],
      live: { graph: "g3", names: ["a"] },
    });
    expect(again.recordsRead).toBe(1);
  });

  test("the first trim ages existing links by when they were linked", () => {
    const f = fixture(T0 - 5 * 24 * HOUR);
    f.link(["ancient"]);
    f.at(T0 - 2 * HOUR);
    f.link(["recent"]);
    f.at(T0);
    f.link(["current"]);
    const r = f.retain({ graph: "g1", names: ["current"], live: null });
    expect(r.migrated).toBe(true);
    expect(linked(f.addressDir)).toEqual(["current", "recent"]);
  });

  test("the first trim refuses a clock that is not the filesystem's", () => {
    const f = fixture();
    f.link(["a"]);
    f.at(T0 - HOUR); // a trim "before" a link compose made

    expect(() => f.retain({ graph: "g1", names: ["a"], live: null })).toThrow(
      /linked at .* after now .* not the filesystem's/,
    );
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
