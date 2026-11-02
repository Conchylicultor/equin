import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { propagateOriginLayer } from "./config-propagate";

// Hermetic: a bundle seed dir and a host config dir, both under a temp root.
// These are the two directories `propagateReleaseConfig` resolves — everything
// interesting about the sync is in what it does BETWEEN them, which is why they
// are parameters rather than derived here.

let root: string;
let seed: AppPath;
let host: AppPath;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "release-config-"));
  seed = asAppPath(join(root, "seed"));
  host = asAppPath(join(root, "host"));
  mkdirSync(seed, { recursive: true });
  mkdirSync(host, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Digests are 12 hex chars on disk, and the header grammar only accepts hex —
// so fixture hashes have to be REAL-shaped. A readable stand-in like "old" is
// simply not a header, and every hash-dependent assertion below would then pass
// or fail for the wrong reason.
const V1 = "0000000000a1";
const V2 = "0000000000b2";
const V3 = "0000000000c3";

/** A config document in the on-disk `// @hash`-header format. */
function doc(hash: string, body: Record<string, unknown>): string {
  return `// @hash ${hash}\n${JSON.stringify(body, null, 2)}\n`;
}

function write(dir: string, rel: string, contents: string): void {
  const path = join(dir, ...rel.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf-8");
}

function read(dir: string, rel: string): string | null {
  const path = join(dir, ...rel.split("/"));
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

describe("propagateOriginLayer", () => {
  test("installs the bundle's origins into an empty host dir", () => {
    write(
      seed,
      "ui/tokens/color-palette/config.origin.jsonc",
      doc(V1, { preset: "default" }),
    );
    write(
      seed,
      "ui/tokens/color-palette/@app/website/config.origin.jsonc",
      doc(V1, { preset: "ocean" }),
    );

    const result = propagateOriginLayer(seed, host);

    expect(result).toEqual({ written: 2, removed: 0 });
    expect(read(host, "ui/tokens/color-palette/config.origin.jsonc")).toContain(
      '"default"',
    );
    // The per-app scope has to arrive too: whether a scope EXISTS is decided by
    // whether its files are on disk, so a scope that never lands reads to the
    // whole app as "this descriptor was never customized" — silently.
    expect(
      read(host, "ui/tokens/color-palette/@app/website/config.origin.jsonc"),
    ).toContain('"ocean"');
  });

  test("refreshes an origin a previous bundle installed", () => {
    // The regression this whole module exists for: the host dir survives a
    // deploy, so a once-only seed serves the FIRST bundle's config forever.
    write(
      host,
      "apps/website/shell/section.origin.jsonc",
      doc(V1, { items: ["intro", "fork"] }),
    );
    write(
      seed,
      "apps/website/shell/section.origin.jsonc",
      doc(V2, { items: ["hero", "fork"] }),
    );

    expect(propagateOriginLayer(seed, host).written).toBe(1);
    expect(read(host, "apps/website/shell/section.origin.jsonc")).toContain(
      "hero",
    );
  });

  test("is a no-op when the host already matches the bundle", () => {
    const bytes = doc(V1, { preset: "ocean" });
    write(seed, "ui/tokens/shape/config.origin.jsonc", bytes);
    write(host, "ui/tokens/shape/config.origin.jsonc", bytes);

    expect(propagateOriginLayer(seed, host)).toEqual({
      written: 0,
      removed: 0,
    });
  });

  test("never touches the user's own override", () => {
    const override = doc(V1, { preset: "mine" });
    write(host, "ui/tokens/shape/config.jsonc", override);
    write(
      host,
      "ui/tokens/shape/config.origin.jsonc",
      doc(V1, { preset: "default" }),
    );
    write(
      seed,
      "ui/tokens/shape/config.origin.jsonc",
      doc(V2, { preset: "rounded" }),
    );

    propagateOriginLayer(seed, host);

    expect(read(host, "ui/tokens/shape/config.jsonc")).toBe(override);
  });

  test("snapshots the ancestor when an in-sync override is about to go stale", () => {
    const oldOrigin = doc(V1, { preset: "default" });
    write(host, "ui/tokens/shape/config.origin.jsonc", oldOrigin);
    write(host, "ui/tokens/shape/config.jsonc", doc(V1, { preset: "mine" }));
    write(
      seed,
      "ui/tokens/shape/config.origin.jsonc",
      doc(V2, { preset: "rounded" }),
    );

    propagateOriginLayer(seed, host);

    // The base the override was written against, preserved verbatim so the
    // settings UI can still offer a three-way Merge rather than binary
    // keep/accept.
    expect(read(host, "ui/tokens/shape/config.ancestor.jsonc")).toBe(oldOrigin);
  });

  test("does not re-snapshot an ancestor once the override is already stale", () => {
    const trueBase = doc(V1, { preset: "default" });
    write(host, "ui/tokens/shape/config.ancestor.jsonc", trueBase);
    write(
      host,
      "ui/tokens/shape/config.origin.jsonc",
      doc(V2, { preset: "rounded" }),
    );
    write(host, "ui/tokens/shape/config.jsonc", doc(V1, { preset: "mine" })); // stale already
    write(
      seed,
      "ui/tokens/shape/config.origin.jsonc",
      doc(V3, { preset: "ocean" }),
    );

    propagateOriginLayer(seed, host);

    expect(read(host, "ui/tokens/shape/config.ancestor.jsonc")).toBe(trueBase);
  });

  test("writes no ancestor when the override is in sync with the new origin", () => {
    write(
      host,
      "ui/tokens/shape/config.origin.jsonc",
      doc(V1, { preset: "default" }),
    );
    write(host, "ui/tokens/shape/config.jsonc", doc(V1, { preset: "mine" }));
    // Same hash, different bytes elsewhere in the file — the override is not
    // going stale, so there is no transition to capture.
    write(
      seed,
      "ui/tokens/shape/config.origin.jsonc",
      doc(V1, { preset: "default", extra: 1 }),
    );

    propagateOriginLayer(seed, host);

    expect(
      existsSync(join(host, "ui/tokens/shape/config.ancestor.jsonc")),
    ).toBe(false);
  });

  test("prunes an origin the bundle no longer ships, and the dir it emptied", () => {
    write(host, "apps/gone/config.origin.jsonc", doc(V1, { x: 1 }));
    write(seed, "apps/kept/config.origin.jsonc", doc(V1, { x: 1 }));

    expect(propagateOriginLayer(seed, host)).toEqual({
      written: 1,
      removed: 1,
    });
    expect(existsSync(join(host, "apps/gone"))).toBe(false);
  });

  test("reverts a per-app scope the bundle stopped shipping", () => {
    // The mirror image of the staleness bug: a scope deleted from version
    // control has to disappear from the host too, or the deployed app keeps a
    // customization nobody can find in the repo.
    write(
      host,
      "ui/tokens/shape/@app/website/config.origin.jsonc",
      doc(V1, { preset: "ocean" }),
    );
    write(
      seed,
      "ui/tokens/shape/config.origin.jsonc",
      doc(V1, { preset: "default" }),
    );

    propagateOriginLayer(seed, host);

    expect(existsSync(join(host, "ui/tokens/shape/@app"))).toBe(false);
  });

  test("keeps a runtime fork's origin, which no bundle ever ships", () => {
    // The app itself wrote this origin when the user first customized the scope
    // through settings. Pruning it as "not shipped" would strand the override
    // beside it — so the sibling override is what marks it as per-user state.
    write(
      host,
      "ui/tokens/shape/@app/mail/config.origin.jsonc",
      doc(V1, { preset: "default" }),
    );
    write(
      host,
      "ui/tokens/shape/@app/mail/config.jsonc",
      doc(V1, { preset: "mine" }),
    );

    expect(propagateOriginLayer(seed, host).removed).toBe(0);
    expect(
      read(host, "ui/tokens/shape/@app/mail/config.origin.jsonc"),
    ).not.toBeNull();
    expect(read(host, "ui/tokens/shape/@app/mail/config.jsonc")).not.toBeNull();
  });

  test("leaves nothing behind but the files it means to write", () => {
    write(seed, "a/config.origin.jsonc", doc(V1, { x: 1 }));
    propagateOriginLayer(seed, host);
    // No stray `.tmp-<uuid>` from the atomic write.
    expect(readdirSync(join(host, "a"))).toEqual(["config.origin.jsonc"]);
  });
});
