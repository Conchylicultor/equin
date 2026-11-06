import { afterAll, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasGlobalCssCache } from "../../core/internal/global-css";
import {
  carryForwardServedEntries,
  globalCssCacheRoot,
  seedAddressDir,
} from "./carry-forward";

const tmp = mkdtempSync(join(tmpdir(), "carry-forward-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;

/**
 * A fresh (cache, live dist, staging dist) triple. The cache holds `store/`
 * (artifact link targets) and `css/` (the CSS cache root); both dists start
 * with empty `artifacts/` and `assets/`, as compose leaves them.
 */
function fixture(): {
  store: string;
  css: string;
  live: string;
  staging: string;
} {
  const root = join(tmp, String(n++));
  const f = {
    store: join(root, "cache", "store"),
    css: join(root, "cache", "css"),
    live: join(root, "web.live.1"),
    staging: join(root, "web.staging.2"),
  };
  for (const d of [
    f.store,
    f.css,
    join(f.live, "artifacts"),
    join(f.live, "assets"),
    join(f.staging, "artifacts"),
    join(f.staging, "assets"),
  ]) {
    mkdirSync(d, { recursive: true });
  }
  return f;
}

/** A published store artifact, linked from `dist/artifacts/<name>`. */
function linkArtifact(store: string, dist: string, name: string): string {
  const target = join(store, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "index.js"), `export const name = "${name}";`);
  symlinkSync(target, join(dist, "artifacts", name));
  return target;
}

describe("seedAddressDir", () => {
  test("seeds every live link whose cache target still exists, once", () => {
    const f = fixture();
    const kept = linkArtifact(f.store, f.live, "tasks.web.aaaa");
    const pruned = linkArtifact(f.store, f.live, "tasks.web.bbbb");
    rmSync(pruned, { recursive: true });
    const addressDir = join(f.live, "..", "web-addresses");
    expect(seedAddressDir({ liveDir: f.live, addressDir })).toBe(1);
    expect(readlinkSync(join(addressDir, "tasks.web.aaaa"))).toBe(kept);
    expect(
      lstatSync(join(addressDir, "tasks.web.bbbb"), { throwIfNoEntry: false }),
    ).toBeUndefined();
    // Seeded: a later build adds to it through compose, never re-seeds it.
    linkArtifact(f.store, f.live, "tasks.web.cccc");
    expect(seedAddressDir({ liveDir: f.live, addressDir })).toBe(0);
    expect(
      lstatSync(join(addressDir, "tasks.web.cccc"), { throwIfNoEntry: false }),
    ).toBeUndefined();
  });

  test("seeds nothing without a live dist", () => {
    const f = fixture();
    const addressDir = join(f.live, "..", "web-addresses");
    expect(
      seedAddressDir({ liveDir: join(f.live, "..", "absent"), addressDir }),
    ).toBe(0);
    expect(lstatSync(addressDir, { throwIfNoEntry: false })).toBeUndefined();
  });

  test("refuses a live artifact that is not a symlink", () => {
    const f = fixture();
    mkdirSync(join(f.live, "artifacts", "tasks.web.cccc"));
    expect(() =>
      seedAddressDir({
        liveDir: f.live,
        addressDir: join(f.live, "..", "web-addresses"),
      }),
    ).toThrow(/not a symlink/);
  });
});

describe("carryForwardServedEntries — assets", () => {
  test("copies an asset some CSS cache dir still holds", () => {
    const f = fixture();
    mkdirSync(join(f.css, "css.0000000000000001"));
    writeFileSync(
      join(f.css, "css.0000000000000001", "inter-latin-AbC.woff2"),
      "font",
    );
    writeFileSync(join(f.live, "assets", "inter-latin-AbC.woff2"), "font");
    const r = carryForwardServedEntries({
      liveDir: f.live,
      stagingDir: f.staging,
      cssCacheRoot: f.css,
    });
    expect(r.assetsCarried).toEqual(["inter-latin-AbC.woff2"]);
    expect(
      readFileSync(join(f.staging, "assets", "inter-latin-AbC.woff2"), "utf8"),
    ).toBe("font");
  });

  test("does not carry an asset no CSS cache dir holds any more", () => {
    const f = fixture();
    mkdirSync(join(f.css, "css.0000000000000002"));
    writeFileSync(join(f.css, "css.0000000000000002", "index-New.css"), "new");
    writeFileSync(join(f.live, "assets", "index-Old.css"), "old");
    const r = carryForwardServedEntries({
      liveDir: f.live,
      stagingDir: f.staging,
      cssCacheRoot: f.css,
    });
    expect(r.assetsCarried).toEqual([]);
    expect(
      lstatSync(join(f.staging, "assets", "index-Old.css"), {
        throwIfNoEntry: false,
      }),
    ).toBeUndefined();
  });

  test("meta.json in a CSS cache dir is not an asset", () => {
    const f = fixture();
    mkdirSync(join(f.css, "css.0000000000000003"));
    writeFileSync(join(f.css, "css.0000000000000003", "meta.json"), "{}");
    writeFileSync(join(f.live, "assets", "meta.json"), "{}");
    const r = carryForwardServedEntries({
      liveDir: f.live,
      stagingDir: f.staging,
      cssCacheRoot: f.css,
    });
    expect(r.assetsCarried).toEqual([]);
  });

  test("leaves the new build's own assets untouched", () => {
    const f = fixture();
    mkdirSync(join(f.css, "css.0000000000000004"));
    writeFileSync(join(f.css, "css.0000000000000004", "index-Same.css"), "x");
    writeFileSync(join(f.live, "assets", "index-Same.css"), "live bytes");
    writeFileSync(join(f.staging, "assets", "index-Same.css"), "staging bytes");
    const r = carryForwardServedEntries({
      liveDir: f.live,
      stagingDir: f.staging,
      cssCacheRoot: f.css,
    });
    expect(r.assetsCarried).toEqual([]);
    expect(
      readFileSync(join(f.staging, "assets", "index-Same.css"), "utf8"),
    ).toBe("staging bytes");
  });
});

describe("carryForwardServedEntries — first build", () => {
  test("is a no-op when there is no live dist", () => {
    const f = fixture();
    const r = carryForwardServedEntries({
      liveDir: join(f.live, "..", "web"), // never published
      stagingDir: f.staging,
      cssCacheRoot: f.css,
    });
    expect(r).toEqual({ assetsCarried: [] });
  });
});

describe("globalCssCacheRoot", () => {
  // `global-css.ts` keeps its cache root private, so the only way to hold the
  // two spellings together is behavioural: a dir made under OUR root must be
  // the one the global CSS pass reports as cached. The key is not hex, so it
  // can never name a real cache entry, and the probe is removed at once.
  test("is the root the global CSS pass caches into", () => {
    const key = `zz-tie-${String(process.pid).padStart(9, "0")}`;
    const dir = join(globalCssCacheRoot(), `css.${key}`);
    expect(hasGlobalCssCache(key)).toBe(false);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, "meta.json"), "{}");
      expect(hasGlobalCssCache(key)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
