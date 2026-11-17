import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressDirOf, publishReleaseDist } from "./release-dist";

const tmp = mkdtempSync(join(tmpdir(), "release-dist-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

const DAY = 24 * 60 * 60 * 1000;

/**
 * A release's bundle web/: materialized artifacts (real dirs), its graph pin,
 * a shell, and assets. `artifacts` maps an address name to its one file's bytes.
 */
function bundle(
  root: string,
  release: string,
  graph: string,
  artifacts: Record<string, string>,
  assets: string[] = [],
): string {
  const web = join(root, "extract", release, "web");
  mkdirSync(join(web, "artifacts"), { recursive: true });
  writeFileSync(join(web, ".build-graph"), graph + "\n");
  writeFileSync(join(web, "index.html"), `<html>${release}</html>`);
  for (const [name, body] of Object.entries(artifacts)) {
    mkdirSync(join(web, "artifacts", name));
    writeFileSync(join(web, "artifacts", name, "index.js"), body);
  }
  if (assets.length > 0) {
    mkdirSync(join(web, "assets"));
    for (const a of assets) writeFileSync(join(web, "assets", a), a);
  }
  return web;
}

/**
 * One release host: `ship` publishes a release the way `launch` does — with
 * what the gateway serves now — and, as the gateway's spec commit would,
 * makes its dist the served one.
 */
function host() {
  const root = join(tmp, `host-${n++}`);
  const nsDir = join(root, "data", "worktrees", "website");
  const servedDist = join(nsDir, "web");
  mkdirSync(nsDir, { recursive: true });
  let served: string | null = null;
  return {
    root,
    nsDir,
    servedDist,
    get served() {
      return served;
    },
    /** What the gateway serves before this layout existed: a bundle's own web/. */
    serveFromExtraction(web: string) {
      served = web;
    },
    ship(web: string, runId: string, opts: { takesOver?: boolean } = {}) {
      const p = publishReleaseDist({
        bundleWeb: web,
        servedDist,
        runId,
        servedNow: served,
      });
      if (opts.takesOver !== false) served = p.dist;
      return p;
    },
    /** A tab's GET /artifacts/<name>/index.js, through what the gateway serves. */
    fetch(name: string): string | null {
      if (served === null) return null;
      const file = join(served, "artifacts", name, "index.js");
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    },
    dists(): string[] {
      return readdirSync(nsDir)
        .filter((e) => e.startsWith("web.live."))
        .sort();
    },
  };
}

describe("publishReleaseDist", () => {
  test("a ship keeps serving the replaced release's addresses after its extraction is gone", () => {
    const h = host();
    h.ship(
      bundle(h.root, "A", "gA", { "set.aaa": "zod-a", "p.1": "p1" }),
      "runA",
    );
    const shipB = h.ship(
      bundle(h.root, "B", "gB", { "set.bbb": "zod-b", "p.1": "p1" }),
      "runB",
    );
    expect(shipB.added).toBe(1); // p.1 is write-once and already there
    expect(h.served).toBe(join(h.nsDir, "web.live.runB"));
    // The ship's prune: every extraction is deleted.
    rmSync(join(h.root, "extract"), { recursive: true, force: true });

    // A tab still on A (the 2026-11-17 404) and a fresh tab on B.
    expect(h.fetch("set.aaa")).toBe("zod-a");
    expect(h.fetch("set.bbb")).toBe("zod-b");
    expect(readFileSync(join(h.served!, "index.html"), "utf8")).toBe(
      "<html>B</html>",
    );
  });

  test("the first ship after this layout imports the release served from its extraction", () => {
    const h = host();
    const old = bundle(h.root, "old", "gOld", { "set.old": "zod-old" }, [
      "font-old.woff2",
    ]);
    h.serveFromExtraction(old);
    h.ship(bundle(h.root, "A", "gA", { "set.aaa": "zod-a" }), "runA");
    rmSync(join(h.root, "extract"), { recursive: true, force: true });
    expect(h.fetch("set.old")).toBe("zod-old");
    expect(h.fetch("set.aaa")).toBe("zod-a");
    expect(readdirSync(join(h.served!, "assets"))).toEqual(["font-old.woff2"]);
    // Its graph is recorded, so its tabs keep it alive like any other.
    expect(existsSync(join(`${h.servedDist}-graphs`, "gOld.names"))).toBe(true);
  });

  test("a release that never takes over changes nothing served", () => {
    const h = host();
    h.ship(bundle(h.root, "A", "gA", { "a.1": "a" }), "runA");
    const before = h.served;
    h.ship(bundle(h.root, "B", "gB", { "b.1": "b" }), "runB", {
      takesOver: false,
    });
    expect(h.served).toBe(before);
    expect(readFileSync(join(h.served!, "index.html"), "utf8")).toBe(
      "<html>A</html>",
    );
    expect(h.fetch("a.1")).toBe("a");
  });

  test("a release no tab needed for a day is dropped; one a tab named stays", () => {
    const h = host();
    const graphs = `${h.servedDist}-graphs`;
    h.ship(bundle(h.root, "A", "gA", { "a.1": "a" }), "runA");
    h.ship(bundle(h.root, "B", "gB", { "b.1": "b" }), "runB");
    h.ship(bundle(h.root, "C", "gC", { "c.1": "c" }), "runC");
    // Two days on: A was last needed when B replaced it; an open tab on B
    // named its graph an hour ago (the backend's touch).
    const twoDaysAgo = new Date(Date.now() - 2 * DAY);
    utimesSync(join(graphs, "gA.names"), twoDaysAgo, twoDaysAgo);
    utimesSync(join(graphs, "gC.names"), twoDaysAgo, twoDaysAgo);
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(join(graphs, "gB.names"), anHourAgo, anHourAgo);
    // The index records when each record was folded; age it with the records.
    const indexPath = join(graphs, "index.json");
    writeFileSync(
      indexPath,
      JSON.stringify({
        v: 1,
        graphs: { gA: 0, gB: 0, gC: 0 },
        names: { "a.1": 0, "b.1": 0, "c.1": 0 },
      }),
    );

    h.ship(bundle(h.root, "D", "gD", { "d.1": "d" }), "runD");
    // a.1: nobody needed A for two days. b.1: a tab. c.1: served until now.
    expect(readdirSync(addressDirOf(h.servedDist)).sort()).toEqual([
      "b.1",
      "c.1",
      "d.1",
    ]);
    // Release dists: the served one and the one it replaced, no more.
    expect(h.dists()).toEqual(["web.live.runC", "web.live.runD"]);
  });

  test("publishing the served release again (a boot after its swap) reuses its dist", () => {
    const h = host();
    const web = bundle(h.root, "A", "gA", { "a.1": "a" });
    const first = h.ship(web, "runA");
    const again = h.ship(web, "runA");
    expect(again.dist).toBe(first.dist);
    expect(again.added).toBe(0);
    expect(h.fetch("a.1")).toBe("a");
    expect(h.dists()).toEqual(["web.live.runA"]);
  });

  test("addresses are hard links into the extraction, outliving it", () => {
    const h = host();
    const web = bundle(h.root, "A", "gA", { "a.1": "a" });
    h.ship(web, "runA");
    const src = statSync(join(web, "artifacts", "a.1", "index.js"));
    const served = statSync(
      join(addressDirOf(h.servedDist), "a.1", "index.js"),
    );
    expect(served.ino).toBe(src.ino);
  });

  test("the replaced release's own fonts are carried, not what it carried itself", () => {
    const h = host();
    h.ship(bundle(h.root, "A", "gA", {}, ["font-a.woff2"]), "runA");
    h.ship(bundle(h.root, "B", "gB", {}, ["font-b.woff2"]), "runB");
    expect(readdirSync(join(h.served!, "assets")).sort()).toEqual([
      "font-a.woff2",
      "font-b.woff2",
    ]);
    h.ship(bundle(h.root, "C", "gC", {}, ["font-c.woff2"]), "runC");
    expect(readdirSync(join(h.served!, "assets")).sort()).toEqual([
      "font-b.woff2",
      "font-c.woff2",
    ]);
  });
});
