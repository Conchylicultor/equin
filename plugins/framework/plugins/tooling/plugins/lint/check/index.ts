import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type {
  Check,
  CheckResult,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { exemptManifestPaths } from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import { LINT_DATA_FILES } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import {
  closureRecord,
  repoModuleOf,
} from "@plugins/plugin-meta/plugins/plugin-records/core";

/**
 * A cold load transpiles the whole lint closure through jiti (~25 s on a busy
 * host); a warm one takes ~3 s. The bound is for a wedged load, not a budget.
 */
const LOAD_TIMEOUT_MS = 180_000;

/** The node on PATH — the runtime the editor's ESLint server stands for. */
function findNode(): string | null {
  return Bun.which("node");
}

/** ESLint's own CLI, as installed for this checkout. */
function eslintBin(root: string): string {
  const require = createRequire(join(root, "package.json"));
  return join(dirname(require.resolve("eslint/package.json")), "bin/eslint.js");
}

/**
 * The root `eslint.config.ts` loads the way the editor loads it: ESLint's own
 * CLI, under NODE, asked for one file's config. Nothing else in the repo loads
 * it like that — `type-check` builds the same config under Bun, which resolves
 * the `@plugins/*` alias and runs Bun-only code natively — so this entry broke
 * three ways with every check green (2026-11-05): a runtime `@plugins/*` import
 * in the config file (ESLint's jiti knows no alias), a Bun-only import reached
 * from a lint rule (`bun:ffi`), and contributions loaded concurrently, which
 * jiti hands back half-built. Each now fails here, with ESLint's own message.
 */
const check: Check = {
  id: "lint:eslint-config-loads",
  description:
    "the root eslint.config.ts loads through ESLint's own CLI under Node, as the editor loads it",
  // The verdict also depends on the Node that runs it, which the tree hash
  // does not cover: fold its version into the key.
  async cacheSignature() {
    const node = findNode();
    if (node === null) return null;
    const v = await spawnCaptured([node, "--version"], { timeoutMs: 10_000 });
    return v.exitCode === 0 ? `node ${v.stdout.trim()}` : null;
  },
  async run(ctx): Promise<CheckResult> {
    const node = findNode();
    if (node === null) {
      return {
        ok: false,
        inconclusive: true,
        message:
          "No `node` on PATH, so the editor's ESLint load cannot be reproduced. The editor runs ESLint under Node; Bun resolves what Node does not, so loading it under Bun proves nothing.",
        hint: "Install Node (e.g. `brew install node`) and re-run `./equin check lint:eslint-config-loads`.",
      };
    }
    const version = await spawnCaptured([node, "--version"], {
      timeoutMs: 10_000,
    });
    if (version.exitCode !== 0)
      throw new Error(
        `lint:eslint-config-loads: \`${node} --version\` exited ${version.exitCode}: ${version.stderr.trim()}`,
      );
    const repo = await ctx.repo();
    const r = await closureRecord<LoadVerdict, CheckResult>(
      repo,
      loadRecordSpec(repo, version.stdout.trim()),
      async () => {
        const verdict = await loadUnderNode(node, repo.root);
        // Only a pass is stored. A failure is not: it is ESLint's own message,
        // which names this checkout's paths (a record is every checkout's),
        // and a timeout is the host's, not the code's — both run again.
        return verdict.ok
          ? { ok: true, value: verdict }
          : { ok: false, error: verdict };
      },
    );
    return r.ok ? r.value : r.error;
  },
};

export default check;

/** What a stored load answers: it loaded, with rules. */
type LoadVerdict = { ok: true };

/**
 * What ESLint's load of `eslint.config.ts` under Node depends on, as a
 * `closureRecord` spec — so a pass after an edit outside everything the load
 * reaches is a lookup, not a Node start that transpiles the lint closure
 * through jiti (0.8–2.5 s warm, every pass):
 *
 *   - `modules` — the code it LOADS. `eslint.config.ts` (its static closure is
 *     npm only), the IDE entry it imports through its aliased jiti by a
 *     computed path (whose closure holds the builder, `lint.generated.ts` and,
 *     through its `import()`s, every lint barrel and rule), every exemption
 *     manifest `loadExemptions` imports by a computed path, and this module
 *     (the producer: the argv and the verdict's reading of the output).
 *   - `input` — what it reads that is not a module: the root `package.json`
 *     (Node reads its `type` to load the config), the lint data files
 *     (`app.css`), and the Node version (the runtime the editor stands for).
 *     The npm code the closures import (eslint, jiti, typescript-eslint) is
 *     keyed by the record (`npmCodeKey`).
 */
function loadRecordSpec(
  repo: RepoSnapshot,
  nodeVersion: string,
): { name: string; modules: string[]; input: unknown } {
  return {
    name: "lint:eslint-config-loads",
    modules: [
      ESLINT_CONFIG,
      IDE_ENTRY,
      ...exemptManifestPaths(repo),
      repoModuleOf(repo, import.meta.url),
    ],
    input: {
      node: nodeVersion,
      read: ["package.json", ...LINT_DATA_FILES].map((p) => [
        p,
        repo.blobOf(p),
      ]),
    },
  };
}

const ESLINT_CONFIG = "eslint.config.ts";
const IDE_ENTRY =
  "plugins/framework/plugins/tooling/plugins/lint/core/ide-lint-config.ts";

/** ESLint's own CLI, under Node, asked for one file's config. */
async function loadUnderNode(node: string, root: string): Promise<CheckResult> {
  const res = await spawnCaptured(
    [node, eslintBin(root), "--print-config", ESLINT_CONFIG],
    { cwd: root, timeoutMs: LOAD_TIMEOUT_MS },
  );
  if (res.timedOut) {
    return {
      ok: false,
      inconclusive: true,
      message: `ESLint did not finish loading eslint.config.ts within ${LOAD_TIMEOUT_MS / 1000} s.`,
      hint: "Re-run `node node_modules/eslint/bin/eslint.js --print-config eslint.config.ts` by hand to see where it stalls.",
    };
  }
  if (res.exitCode !== 0) {
    const said = (res.stderr.trim() || res.stdout.trim())
      .split("\n")
      .filter((l) => !/^\s+at /.test(l))
      .slice(0, 30)
      .join("\n");
    return {
      ok: false,
      message: `ESLint (under Node) could not load eslint.config.ts, so the editor's linting is broken:\n${said}`,
      hint:
        "eslint.config.ts may import only npm packages and node builtins at runtime (`@plugins/*` is loaded through its aliased jiti), " +
        "and nothing the IDE entry (lint/core/ide-lint-config.ts) reaches may need Bun (`Bun.*`, `bun:ffi`, infra/spawn). " +
        "Reproduce: `node node_modules/eslint/bin/eslint.js --print-config eslint.config.ts`.",
    };
  }
  const config = JSON.parse(res.stdout) as {
    rules?: Record<string, unknown>;
  };
  const rules = Object.keys(config.rules ?? {}).length;
  if (rules === 0) {
    return {
      ok: false,
      message:
        "ESLint loaded eslint.config.ts but resolved no rules for it — the editor would lint nothing.",
    };
  }
  return { ok: true };
}
