import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  statSync,
  utimesSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  loadVendorResolutionCache,
  saveVendorResolutionCache,
  validateVendorRecord,
  vendorCacheKey,
  type VendorResolutionCache,
  type VendorResolutionRecord,
} from "./vendor-cache";

function fixtureDir(): AppPath {
  return asAppPath(mkdtempSync(join(tmpdir(), "vendor-cache-test-")));
}

/** A record whose read-set is the given files, stamped as they are right now. */
function recordOver(files: string[]): VendorResolutionRecord {
  const stamped: Record<string, [number, number]> = {};
  for (const f of files) {
    const stat = statSync(f);
    stamped[f] = [stat.mtimeMs, stat.size];
  }
  return {
    entryFile: files[0]!,
    version: "1.2.3",
    cjs: false,
    wrapper: `export * from "pkg";\n`,
    files: stamped,
  };
}

describe("validateVendorRecord (the read-set hit rule)", () => {
  test("unchanged read-set ⇒ hit", () => {
    const dir = fixtureDir();
    const entry = joinAppPath(dir, "index.js");
    const pj = joinAppPath(dir, "package.json");
    writeFileSync(entry, "export const x = 1;");
    writeFileSync(pj, `{"version":"1.2.3","type":"module"}`);

    expect(validateVendorRecord(recordOver([entry, pj]))).toBe(true);
  });

  test("mtime change ⇒ miss (a touched file may be different bytes)", () => {
    const dir = fixtureDir();
    const entry = joinAppPath(dir, "index.js");
    writeFileSync(entry, "export const x = 1;");
    const record = recordOver([entry]);

    const later = new Date(Date.now() + 5_000);
    utimesSync(entry, later, later);
    expect(validateVendorRecord(record)).toBe(false);
  });

  test("size change ⇒ miss", () => {
    const dir = fixtureDir();
    const entry = joinAppPath(dir, "index.js");
    writeFileSync(entry, "export const x = 1;");
    const record = recordOver([entry]);

    // Same mtime, different length: a patched package that kept its timestamp.
    const [mtimeMs] = record.files[entry]!;
    writeFileSync(entry, "export const x = 1; export const y = 2;");
    const stamp = new Date(mtimeMs);
    utimesSync(entry, stamp, stamp);
    expect(validateVendorRecord(record)).toBe(false);
  });

  test("deleted file ⇒ miss, not a throw", () => {
    const dir = fixtureDir();
    const entry = joinAppPath(dir, "index.js");
    writeFileSync(entry, "export const x = 1;");
    const record = recordOver([entry]);

    rmSync(entry);
    expect(validateVendorRecord(record)).toBe(false);
  });

  test("every recorded file counts, not just the entry", () => {
    const dir = fixtureDir();
    const entry = joinAppPath(dir, "index.js");
    const reexported = joinAppPath(dir, "lib.js");
    writeFileSync(entry, "module.exports = require('./lib');");
    writeFileSync(reexported, "exports.a = 1;");
    const record = recordOver([entry, reexported]);

    // The entry is untouched — only a file it re-exports from moved.
    writeFileSync(reexported, "exports.a = 1; exports.b = 2;");
    expect(validateVendorRecord(record)).toBe(false);
  });
});

describe("load / save (the persisted cache)", () => {
  const gate = "gate-a";

  function cacheWith(record: VendorResolutionRecord): VendorResolutionCache {
    return {
      version: 1,
      gate,
      records: {
        [vendorCacheKey(asAppPath("/repo/plugins/x"), "react")]: record,
      },
    };
  }

  test("round-trips through the file", () => {
    const dir = fixtureDir();
    const file = joinAppPath(dir, "nested", "wt.json"); // save creates the dir
    const entry = joinAppPath(dir, "index.js");
    writeFileSync(entry, "export const x = 1;");
    const cache = cacheWith(recordOver([entry]));

    saveVendorResolutionCache(file, cache);
    expect(loadVendorResolutionCache(file, gate)).toEqual(cache);
  });

  test("absent file ⇒ empty cache at the current gate", () => {
    const dir = fixtureDir();
    const loaded = loadVendorResolutionCache(
      joinAppPath(dir, "missing.json"),
      gate,
    );
    expect(loaded).toEqual({ version: 1, gate, records: {} });
  });

  test("a different gate drops every record", () => {
    const dir = fixtureDir();
    const file = joinAppPath(dir, "wt.json");
    const entry = joinAppPath(dir, "index.js");
    writeFileSync(entry, "export const x = 1;");
    saveVendorResolutionCache(file, cacheWith(recordOver([entry])));

    // The install moved (bun.lock changed) — nothing recorded under the old
    // gate is trustworthy, including records whose files still stat identical.
    const loaded = loadVendorResolutionCache(file, "gate-b");
    expect(loaded).toEqual({ version: 1, gate: "gate-b", records: {} });
  });

  test("unparseable file ⇒ empty cache", () => {
    const dir = fixtureDir();
    const file = joinAppPath(dir, "wt.json");
    writeFileSync(file, "{ not json");
    expect(loadVendorResolutionCache(file, gate)).toEqual({
      version: 1,
      gate,
      records: {},
    });
  });

  test("wrong version ⇒ empty cache", () => {
    const dir = fixtureDir();
    const file = joinAppPath(dir, "wt.json");
    writeFileSync(
      file,
      JSON.stringify({ version: 999, gate, records: { k: {} } }),
    );
    expect(loadVendorResolutionCache(file, gate)).toEqual({
      version: 1,
      gate,
      records: {},
    });
  });
});

describe("vendorCacheKey", () => {
  test("the same specifier from two resolveDirs is two records", () => {
    // Under bun's isolated installs the same bare specifier resolves to
    // different copies depending on the importing plugin's dir.
    expect(vendorCacheKey(asAppPath("/a"), "react")).not.toBe(
      vendorCacheKey(asAppPath("/b"), "react"),
    );
  });
});
