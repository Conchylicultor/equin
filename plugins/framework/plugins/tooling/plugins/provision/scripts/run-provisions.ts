#!/usr/bin/env bun
/**
 * Install-time provisioning runner — the generic counterpart to the check / lint
 * collected-dir registries, invoked by the root `package.json` postinstall.
 *
 * A plugin contributes an install-time provisioning step by dropping a
 * `plugins/<name>/provision/index.ts` that default-exports
 * `async function provision(): Promise<void>`. Codegen discovers it (via the
 * `defineCollectedDir("provision")` marker in this plugin's core) into
 * `../core/provision.generated.ts`; this runner walks that registry and awaits
 * each contribution.
 *
 * ALIAS-FREE: this runs in the `bun install` postinstall context, where the
 * `@plugins/*` path alias does NOT resolve. So it uses only node builtins +
 * relative imports, and dynamic-imports each contribution by ABSOLUTE PATH
 * reconstructed from its `pluginPath` — exactly like
 * `lint/core/build-lint-config.ts:loadContributions` (which ignores the
 * generated alias `loader` for the same reason). It FAILS LOUD: any contribution
 * that fails to load, is malformed, or rejects aborts the whole install with a
 * combined error — never the warn-and-continue of `loadCollectedDir`.
 */
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { provisionEntries } from "../core/provision.generated";

/**
 * Walk up from this script's directory to the repo root — the unique ancestor
 * whose `package.json` declares a `workspaces` field (intermediate plugin
 * package.json files do not). Robust to the plugin's nesting depth (no brittle
 * "../../.." count, and not fooled by the nested `plugins/` dirs every umbrella
 * plugin has).
 */
function findRepoRoot(start: string): string {
  for (let dir = start; ; ) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          workspaces?: unknown;
        };
        if (pkg.workspaces !== undefined) return dir;
      } catch (err) {
        // A malformed package.json at an ancestor is a real problem if it's the
        // root; surface it rather than silently walking past.
        throw new Error(
          `[provision] failed to parse ${pkgPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `[provision] could not locate repo root (no ancestor of ${start} has a package.json with a "workspaces" field)`,
      );
    }
    dir = parent;
  }
}

async function runProvisions(): Promise<void> {
  const root = findRepoRoot(import.meta.dir);
  const failures: string[] = [];

  for (const entry of provisionEntries) {
    console.log(`[provision] ${entry.pluginPath}`);
    const modUrl = pathToFileURL(
      join(root, "plugins", entry.pluginPath, "provision", "index.ts"),
    ).href;
    try {
      const mod = (await import(modUrl)) as { default?: unknown };
      const provision = mod.default;
      if (typeof provision !== "function") {
        failures.push(
          `${entry.pluginPath}/provision — default export is not a function`,
        );
        continue;
      }
      await (provision as () => Promise<void>)();
    } catch (err) {
      failures.push(
        `${entry.pluginPath}/provision — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[provision] ${failures.length} provisioning step(s) failed:\n  ${failures.join("\n  ")}`,
    );
  }
}

runProvisions().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
