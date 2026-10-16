import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { computeHash } from "@plugins/config_v2/core";
import { collectConfigGitLayer } from "./config-git-layer-gen";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "config-git-layer-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, hash: string, body: unknown): void {
  const full = join(root, "config", rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `// @hash ${hash}\n${JSON.stringify(body, null, 2)}\n`);
}

test("keeps only what the committed layer arranges, keyed by storePath", () => {
  const origin = { views: [], on: true };
  const h = computeHash(origin);
  // Origin only — equals the code defaults, never shipped.
  write("a/plain/config.origin.jsonc", h, origin);
  // An honored override.
  write("b/sidebar/list.origin.jsonc", h, origin);
  write("b/sidebar/list.jsonc", h, { views: ["queue"], on: true });
  // A stale override (loses to its origin) and an @app scope.
  write("c/theme/theme.origin.jsonc", h, origin);
  write("c/theme/theme.jsonc", "000000000000", { views: ["x"], on: true });
  write("c/theme/@app/pages/theme.jsonc", h, { on: false });

  const everything = {
    plugins: new Set(["a.plain", "b.sidebar", "c.theme"]),
    apps: new Set(["pages"]),
  };
  expect(collectConfigGitLayer(root, everything)).toEqual({
    "b/sidebar/list.jsonc": {
      base: { views: ["queue"], on: true },
      scopes: {},
    },
    "c/theme/theme.jsonc": {
      base: origin,
      scopes: { pages: { views: [], on: false } },
    },
  });
});

test("carries only the composition's own plugins and apps", () => {
  const origin = { views: [], on: true };
  const h = computeHash(origin);
  write("in/sidebar/list.origin.jsonc", h, origin);
  write("in/sidebar/list.jsonc", h, { views: ["queue"], on: true });
  // Plugin outside the composition: its override never ships.
  write("out/mail/list.origin.jsonc", h, origin);
  write("out/mail/list.jsonc", h, { views: ["inbox"], on: true });
  // Included plugin, one scope for an included app and one for an absent app.
  write("in/theme/theme.origin.jsonc", h, origin);
  write("in/theme/@app/agent-manager/theme.jsonc", h, { on: false });
  write("in/theme/@app/mail/theme.jsonc", h, { views: ["m"] });
  // Included plugin whose ONLY arrangement is an absent app's scope: dropped.
  write("in/tree/tree.origin.jsonc", h, origin);
  write("in/tree/@app/mail/tree.jsonc", h, { on: false });

  expect(
    collectConfigGitLayer(root, {
      plugins: new Set(["in.sidebar", "in.theme", "in.tree"]),
      apps: new Set(["agent-manager"]),
    }),
  ).toEqual({
    "in/sidebar/list.jsonc": {
      base: { views: ["queue"], on: true },
      scopes: {},
    },
    "in/theme/theme.jsonc": {
      base: origin,
      scopes: { "agent-manager": { views: [], on: false } },
    },
  });
});
