import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { computeHash, type JsonValue } from "@plugins/config_v2/core";
import { compositionsConfig } from "@plugins/plugin-meta/plugins/composition/core";
import { readCheckoutCompositions } from "./build-targets";

let root: AppPath;

beforeEach(() => {
  root = asAppPath(mkdtempSync(join(tmpdir(), "build-targets-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The regression: an entry point added to the `website` composition on a branch
// built "OK" but never reached `web.composition.website.generated.ts`. Target
// resolution reads the manifest before stage 2 regenerates
// `config/plugin-meta/composition/compositions.origin.jsonc` from `config.ts`,
// so it read the PREVIOUS origin. The committed origin here stands for that
// file one generation behind the descriptor.
test("a composition edit on the branch reaches the build's manifest before its origin is regenerated", () => {
  const current = compositionsConfig.defaults;
  const before = {
    ...current,
    manifests: current.manifests.map((m) => ({
      ...m,
      entryPoints: m.entryPoints.slice(0, -1),
    })),
  } as unknown as JsonValue;
  const dir = join(root, "config", "plugin-meta", "composition");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "compositions.origin.jsonc"),
    `// @hash ${computeHash(before)}\n${JSON.stringify(before)}\n`,
  );

  // A checkout no namespace exists for: no user layer to read.
  const manifest = readCheckoutCompositions(root, {
    kind: "worktree",
    name: "build-targets-test-no-such-checkout",
  });
  expect(manifest).toEqual(current.manifests);
});
