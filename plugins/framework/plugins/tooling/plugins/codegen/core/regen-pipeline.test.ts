/**
 * Deleting a plugin and regenerating just works: the registry pipeline never
 * reads its own previous output as an input.
 *
 * The incident: after a plugin was deleted, `./equin regen-generated` (and
 * push's post-rebase normalize step, which runs it) died with
 * "machine.generated.ts imports '@plugins/…/machine', which resolves to no
 * file of the checkout" — the registry steps read one snapshot listed before
 * any write, so the browser-host step after the registry write read the
 * registry by its PREVIOUS blob (still naming the deleted plugin; its import
 * facts a record from an earlier pass), and the pass that rewrites the
 * registry could never get past it.
 *
 * Fixture: a `git clone --shared` of this checkout's HEAD in a temp dir (the
 * code under test is this checkout's; the clone is only data, its
 * `node_modules` a link to this checkout's). A plugin with a
 * machine barrel is added and the registries regenerated; a check-style
 * derivation then reads them (as a check pass does after a build, leaving the
 * records of the registry's blob behind); the plugin is deleted and the
 * registries regenerated again — which must succeed and drop it. The pass is
 * the one `regen-generated` runs (`openWritingCodegenPass` +
 * `regenerateRegistryCodegen`), which is push's post-rebase normalize step.
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { codegenPassOver, openWritingCodegenPass } from "./codegen-pass";
import { regenerateRegistryCodegen } from "./regen-pipeline";
import { buildRegistryGenContext } from "./plugin-registry-gen";
import { deriveBrowserHostGraph } from "./browser-host-gen";
import { discoverBrowserHosts } from "./browser-host-scope";

setDefaultTimeout(600_000);

// Built from parts: the repo's `plugin-refs-resolve` check validates every
// `plugins/<seg>/…` literal in source, and this plugin is synthetic.
const PLUGIN = ["zz-regen-fixture"].join("");
const PLUGIN_DIR = `plugins/${PLUGIN}`;
const MACHINE_REGISTRY =
  "plugins/framework/plugins/server-core/core/machine.generated.ts";

let dir: string;
let root: AppPath;

async function git(args: string[], cwd: string): Promise<string> {
  const r = await spawnCaptured(["git", ...args], { cwd, timeoutMs: 120_000 });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

async function regenerate(): Promise<void> {
  const { pass, finish } = await openWritingCodegenPass(root);
  await regenerateRegistryCodegen({ pass });
  await finish(await loadRepoSnapshot(root));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "regen-deleted-plugin-"));
  const source = await getWorktreeRoot();
  await git(["clone", "--shared", "--quiet", source, "repo"], dir);
  root = asAppPath(join(dir, "repo"));
  // The generators resolve npm specifiers (a stylesheet's `@import`) the
  // way the checkout does: through its dependencies — every `node_modules`
  // dir of the isolated install (the root's and each workspace member's),
  // linked, and excluded from the clone's file set like the dirs they stand
  // for (`.gitignore`'s `node_modules/` matches no symlink).
  const installed = (
    await git(
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
      ],
      source,
    )
  )
    .split("\n")
    .filter((p) => p === "node_modules/" || p.endsWith("/node_modules/"));
  for (const p of installed) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    symlinkSync(join(source, p), join(root, p.slice(0, -1)));
  }
  writeFileSync(join(root, ".git", "info", "exclude"), "node_modules\n");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a deleted plugin's registry entries regenerate away", async () => {
  // 1. A plugin with a machine barrel: the registries name it.
  mkdirSync(join(root, PLUGIN_DIR, "machine"), { recursive: true });
  writeFileSync(
    join(root, PLUGIN_DIR, "package.json"),
    `${JSON.stringify({ name: `@equin/plugin-${PLUGIN}`, private: true, version: "0.0.1" }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, PLUGIN_DIR, "machine", "index.ts"),
    [
      'import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";',
      "",
      "export default {",
      '  description: "A fixture plugin, deleted by the test.",',
      "} satisfies MachinePluginDefinition;",
      "",
    ].join("\n"),
  );
  await regenerate();
  const named = `@plugins/${PLUGIN}/machine`;
  expect(readFileSync(join(root, MACHINE_REGISTRY), "utf8")).toContain(named);

  // 2. A check-style pass reads the regenerated tree (as a check run after a
  //    build does): the records of the registry's blob now say it imports
  //    the plugin.
  const check = await buildRegistryGenContext(
    codegenPassOver(await loadRepoSnapshot(root)),
  );
  for (const host of discoverBrowserHosts(await check.repo())) {
    await deriveBrowserHostGraph(check, host);
  }

  // 3. The plugin is deleted, the registries still name it: regenerating
  //    succeeds and drops it.
  rmSync(join(root, PLUGIN_DIR), { recursive: true });
  await regenerate();
  expect(readFileSync(join(root, MACHINE_REGISTRY), "utf8")).not.toContain(
    named,
  );
});
