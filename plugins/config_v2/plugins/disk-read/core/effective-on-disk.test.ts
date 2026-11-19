import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { readEffectiveConfigFromDisk } from "./effective-on-disk";
import { computeHash, defineConfig } from "@plugins/config_v2/core";
import type { JsonValue } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";

let configDir: AppPath;

beforeEach(() => {
  configDir = asAppPath(mkdtempSync(join(tmpdir(), "config-disk-read-")));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const full = join(configDir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

// ── readEffectiveConfigFromDisk ────────────────────────────────────────────
// The build reads this BEFORE its own propagation stage, so the user-layer
// origin on disk is the previous build's. It must resolve against this
// checkout's git layer, or a field added since then reads as its default.

const twoFields = {
  enabled: boolField({ label: "Enabled", default: true }),
  home: textField({ label: "Home", default: "sonata" }),
};
// What codegen writes as the committed origin: the descriptor's defaults, under
// their own hash.
const gitDoc = { enabled: true, home: "sonata" };
const gitHash = computeHash(gitDoc);

function writeDoc(rel: string, content: JsonValue, hash: string): void {
  write(rel, `// @hash ${hash}\n${JSON.stringify(content)}\n`);
}

async function readEffective() {
  return readEffectiveConfigFromDisk(
    defineConfig({ name: "cfg", fields: twoFields }),
    {
      root: configDir,
      userConfigDir: joinAppPath(configDir, "user"),
      hierarchyPath: "p",
    },
  );
}

test("resolves against the git origin, not a stale propagated user origin", async () => {
  writeDoc("config/p/cfg.origin.jsonc", gitDoc, gitHash);
  // Propagated before `home` existed.
  const stale = { enabled: true };
  writeDoc("user/p/cfg.origin.jsonc", stale, computeHash(stale));

  expect((await readEffective()).home).toBe("sonata");
});

test("a user override wins only while written against the git-effective document", async () => {
  writeDoc("config/p/cfg.origin.jsonc", gitDoc, gitHash);
  writeDoc("user/p/cfg.origin.jsonc", gitDoc, computeHash(gitDoc));

  const current = { enabled: false, home: "sonata" };
  writeDoc("user/p/cfg.jsonc", current, computeHash(gitDoc));
  expect((await readEffective()).enabled).toBe(false);

  // Written against an older origin: a conflict, so the git value stands.
  writeDoc("user/p/cfg.jsonc", current, computeHash({ enabled: true }));
  expect((await readEffective()).enabled).toBe(true);
});

test("falls back to the user origin when the git layer has no document", async () => {
  const doc = { enabled: false, home: "x" };
  writeDoc("user/p/cfg.origin.jsonc", doc, computeHash(doc));

  expect(await readEffective()).toEqual({ enabled: false, home: "x" });
});

// The build reads this before it regenerates the committed origins from the
// descriptors, so a default edited on the branch is one generation ahead of
// `config/…/*.origin.jsonc` for the whole first half of the build — a
// `--composition` build served the previous composition list that way.
test("a committed origin older than its descriptor reads as the descriptor's defaults", async () => {
  const before = { enabled: true, home: "website" };
  writeDoc("config/p/cfg.origin.jsonc", before, computeHash(before));
  writeDoc("user/p/cfg.origin.jsonc", before, computeHash(before));
  // Written against the old origin: stale against the regenerated one.
  const mine = { enabled: false, home: "website" };
  writeDoc("user/p/cfg.jsonc", mine, computeHash(before));

  expect(await readEffective()).toEqual(gitDoc);
});
