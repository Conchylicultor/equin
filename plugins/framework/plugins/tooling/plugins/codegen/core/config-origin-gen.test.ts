import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  pruneOrphanedConfigFiles,
  renderOriginJsonc,
} from "./config-origin-gen";
import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";

let configDir: AppPath;

beforeEach(() => {
  configDir = asAppPath(mkdtempSync(join(tmpdir(), "config-prune-")));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function write(rel: string, content = "// @hash abc\n{}\n"): void {
  const full = join(configDir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

test("keeps every file backed by a live descriptor", () => {
  write("apps/pages/shell/pages.sidebar.origin.jsonc");
  write("apps/pages/shell/pages.sidebar.jsonc");
  write("apps/pages/shell/@app/agents/pages.sidebar.jsonc");

  const pruned = pruneOrphanedConfigFiles({
    configDir,
    liveOriginRelPaths: new Set([
      "apps/pages/shell/pages.sidebar.origin.jsonc",
    ]),
  });

  expect(pruned).toEqual([]);
  expect(
    existsSync(join(configDir, "apps/pages/shell/pages.sidebar.origin.jsonc")),
  ).toBe(true);
  expect(
    existsSync(join(configDir, "apps/pages/shell/pages.sidebar.jsonc")),
  ).toBe(true);
  expect(
    existsSync(
      join(configDir, "apps/pages/shell/@app/agents/pages.sidebar.jsonc"),
    ),
  ).toBe(true);
});

test("prunes a removed descriptor's generated files", () => {
  write("apps/pages/shell/pages.toolbar.origin.jsonc");
  write("apps/pages/shell/pages.toolbar.ancestor.jsonc");

  const pruned = pruneOrphanedConfigFiles({
    configDir,
    liveOriginRelPaths: new Set(), // descriptor gone
  });

  expect(pruned.sort()).toEqual([
    "apps/pages/shell/pages.toolbar.ancestor.jsonc",
    "apps/pages/shell/pages.toolbar.origin.jsonc",
  ]);
  expect(existsSync(join(configDir, "apps/pages/shell"))).toBe(false);
});

test("prunes only the dead descriptor when a sibling stays live", () => {
  write("apps/pages/shell/pages.sidebar.origin.jsonc");
  write("apps/pages/shell/pages.sidebar.jsonc");
  write("apps/pages/shell/pages.toolbar.origin.jsonc");

  const pruned = pruneOrphanedConfigFiles({
    configDir,
    liveOriginRelPaths: new Set([
      "apps/pages/shell/pages.sidebar.origin.jsonc",
    ]),
  });

  expect(pruned).toEqual(["apps/pages/shell/pages.toolbar.origin.jsonc"]);
  // The live sibling and its directory survive.
  expect(
    existsSync(join(configDir, "apps/pages/shell/pages.sidebar.origin.jsonc")),
  ).toBe(true);
  expect(
    existsSync(join(configDir, "apps/pages/shell/pages.sidebar.jsonc")),
  ).toBe(true);
});

// An authored override's bytes exist nowhere else, so losing its descriptor is a
// question for a human — most often a rename in progress — not a delete.
test("throws instead of deleting an orphaned authored override", () => {
  write("apps/pages/shell/pages.toolbar.origin.jsonc");
  write("apps/pages/shell/pages.toolbar.jsonc");

  expect(() =>
    pruneOrphanedConfigFiles({ configDir, liveOriginRelPaths: new Set() }),
  ).toThrow("config/apps/pages/shell/pages.toolbar.jsonc");
});

test("an orphaned scoped delta is authored too, so it throws", () => {
  write("apps/pages/shell/@app/agents/pages.toolbar.jsonc");

  expect(() =>
    pruneOrphanedConfigFiles({ configDir, liveOriginRelPaths: new Set() }),
  ).toThrow("config/apps/pages/shell/@app/agents/pages.toolbar.jsonc");
});

// Classification precedes every unlink, so a refused build can simply be re-run
// after the fix rather than leaving a half-pruned tree behind.
test("deletes nothing at all when any override is stranded", () => {
  write("apps/pages/shell/pages.toolbar.origin.jsonc");
  write("apps/pages/shell/pages.toolbar.jsonc");
  write("build/build.origin.jsonc"); // prunable, but must survive the throw

  expect(() =>
    pruneOrphanedConfigFiles({ configDir, liveOriginRelPaths: new Set() }),
  ).toThrow();

  expect(existsSync(join(configDir, "build/build.origin.jsonc"))).toBe(true);
  expect(
    existsSync(join(configDir, "apps/pages/shell/pages.toolbar.origin.jsonc")),
  ).toBe(true);
  expect(
    existsSync(join(configDir, "apps/pages/shell/pages.toolbar.jsonc")),
  ).toBe(true);
});

test("keeps a scoped delta whose base descriptor is still live", () => {
  write("apps/pages/shell/pages.sidebar.origin.jsonc");
  write("apps/pages/shell/@app/agents/pages.sidebar.jsonc");

  const pruned = pruneOrphanedConfigFiles({
    configDir,
    liveOriginRelPaths: new Set([
      "apps/pages/shell/pages.sidebar.origin.jsonc",
    ]),
  });

  expect(pruned).toEqual([]);
  expect(
    existsSync(
      join(configDir, "apps/pages/shell/@app/agents/pages.sidebar.jsonc"),
    ),
  ).toBe(true);
});

test("leaves non-config files (CLAUDE.md) untouched", () => {
  writeFileSync(join(configDir, "CLAUDE.md"), "# config layout\n");
  write("apps/pages/shell/pages.toolbar.origin.jsonc");

  pruneOrphanedConfigFiles({ configDir, liveOriginRelPaths: new Set() });

  expect(existsSync(join(configDir, "CLAUDE.md"))).toBe(true);
  expect(
    existsSync(join(configDir, "apps/pages/shell/pages.toolbar.origin.jsonc")),
  ).toBe(false);
});

test("is a no-op on a clean tree where every file is live", () => {
  write("build/build.origin.jsonc");
  write("apps/pages/shell/pages.sidebar.origin.jsonc");

  const pruned = pruneOrphanedConfigFiles({
    configDir,
    liveOriginRelPaths: new Set([
      "build/build.origin.jsonc",
      "apps/pages/shell/pages.sidebar.origin.jsonc",
    ]),
  });

  expect(pruned).toEqual([]);
});

// `originDefaultsFrom` is a CLAIM about who supplies the origin's defaults, and
// the provider decides applicability on its own. Rendering is where the two meet,
// so it asserts they agree — in both directions, since either disagreement writes
// an `@hash` over a document some later reader would test the wrong basis against.

const fields = { enabled: boolField({ label: "Enabled", default: true }) };

test("throws when a provider materializes defaults a descriptor did not declare", () => {
  const descriptor = defineConfig({ name: "toolbar", fields });

  expect(() =>
    renderOriginJsonc(descriptor, "apps/pages/shell", undefined, () => ({
      enabled: false,
    })),
  ).toThrow("apps/pages/shell/toolbar");
});

test('throws when a "build" descriptor gets no materialized defaults', () => {
  const descriptor = defineConfig({
    name: "toolbar",
    fields,
    originDefaultsFrom: "build",
  });

  // No provider at all — the same shape as a provider that does not recognise
  // this descriptor, which is what a missing preparer registration looks like.
  expect(() => renderOriginJsonc(descriptor, "apps/pages/shell")).toThrow(
    "apps/pages/shell/toolbar",
  );
});

test("renders when the declaration and the provider agree", () => {
  const declared = defineConfig({ name: "toolbar", fields });
  expect(renderOriginJsonc(declared, "apps/pages/shell")).toContain(
    '"enabled": true',
  );

  const built = defineConfig({
    name: "toolbar",
    fields,
    originDefaultsFrom: "build",
  });
  expect(
    renderOriginJsonc(built, "apps/pages/shell", undefined, () => ({
      enabled: false,
    })),
  ).toContain('"enabled": false');
});
