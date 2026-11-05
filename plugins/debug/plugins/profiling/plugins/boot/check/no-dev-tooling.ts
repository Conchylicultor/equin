import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { importClosures } from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import { backendEntries } from "./backend-entries";

/**
 * Packages that exist to BUILD the app — the compiler, the linter, the
 * formatter — and that no serving backend needs to start. Matched on the
 * package name (a scoped prefix ends in `/`).
 */
const DEV_TOOLING = [
  "typescript",
  "eslint",
  "eslint-",
  "@eslint/",
  "@typescript-eslint/",
  "prettier",
  "@babel/",
  "vite",
  "vitest",
];

function isDevTooling(specifier: string): boolean {
  const parts = specifier.split("/");
  const pkg = specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
  return DEV_TOOLING.some((t) =>
    t.endsWith("/") || t.endsWith("-") ? pkg.startsWith(t) : pkg === t,
  );
}

/**
 * Every backend boots the same static closure: its bin plus every server and
 * machine barrel of the registries, each load wave importing its members'
 * whole static graphs before the socket's routes go in. Whatever a module in
 * it imports at module scope is paid on EVERY boot, and on a machine whose
 * file cache lives under a minute it is paid from disk.
 *
 * Measured 2026-11-04: two convenience imports — codegen's barrel for one
 * directory listing (reclaim) and a tsconfig reader (type-check's
 * spawn-worker) — put eslint, @typescript-eslint and the whole TypeScript
 * compiler (~300 npm modules + 8.9 MB) on main's boot, ~0.5 s warm and
 * 3.5–5.6 s on a cold cache, for work no boot runs. Code that needs the build
 * tooling at runtime loads it where it runs, with `await import(…)`.
 *
 * Measured with dynamic imports cut: the subject is what evaluates before a
 * barrel's `register` runs.
 */
const check: Check = {
  id: "boot:closure-no-dev-tooling",
  description:
    "the backend's boot closure (its bin plus every server/machine registry barrel, dynamic imports cut) statically loads no build tooling — typescript, eslint, @typescript-eslint, prettier, babel, vite",
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    const found = await backendEntries(repo);
    if (!found.ok) return found.result;
    const closure = await importClosures(repo.root, found.entries, {
      dynamicImports: "cut",
    });
    const findings: string[] = [];
    for (const [specifier, importers] of closure.external) {
      if (!isDevTooling(specifier)) continue;
      const chain = importers
        .map((i) => closure.importChain(i))
        .reduce((a, b) => (b.length < a.length ? b : a));
      findings.push(
        `${specifier} — imported by ${importers.length} module(s), shortest chain:\n      ` +
          chain.join("\n    → "),
      );
    }
    if (findings.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        `the backend's boot closure (${closure.modules.size} modules) loads build tooling:\n  ` +
        findings.join("\n  "),
      hint:
        'Load the tooling where it runs — `const { f } = await import("…")` inside the function ' +
        "that needs it — or import a leaf that does not reach it. A static edge from any server or " +
        "machine module puts the whole package on every backend boot.",
    };
  },
};

export default check;
