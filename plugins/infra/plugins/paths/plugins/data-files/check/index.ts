import { join } from "node:path";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import { loadTypescript } from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import {
  parseRootBindings,
  parseRootDeclarations,
  rootOwnerProblems,
  rootsBoundProblems,
  selfAndAncestors,
  type RootDeclaration,
} from "./roots";

const HINT_DOC =
  "See plugins/infra/plugins/paths/plugins/data-files/CLAUDE.md.";

/** Every `defineFileRoot` call outside test code, parsed. */
async function rootDeclarations(root: string): Promise<RootDeclaration[]> {
  const ts = await loadTypescript();
  const out: RootDeclaration[] = [];
  for (const { rel, src } of await listCandidateSources({
    root,
    grepArg: "defineFileRoot",
    fixed: true,
  })) {
    if (isTestCodePath(rel.split("/"))) continue;
    out.push(...parseRootDeclarations(ts, rel, src));
  }
  return out;
}

function verdict(problems: string[], hint: string): CheckResult {
  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    message: `${problems.length} file-root problem(s):\n    ${problems.join("\n    ")}`,
    hint: `${hint} ${HINT_DOC}`,
  };
}

const rootsBound: Check = {
  id: "data-files:roots-bound",
  description:
    "every file root (defineFileRoot) is declared in a server/ with literal id and dir, ids are unique, and exactly one FileRootLocation in a machine/ binds it — so the desktop's boot-time binding assert can never be the first to notice",
  async run(ctx) {
    const repo = await ctx.repo();
    const ts = await loadTypescript();
    const decls = await rootDeclarations(repo.root);
    const bindings = [];
    for (const { rel, src } of await listCandidateSources({
      root: repo.root,
      grepArg: "FileRootLocation",
      fixed: true,
    })) {
      if (isTestCodePath(rel.split("/"))) continue;
      bindings.push(...parseRootBindings(ts, rel, src));
    }
    return verdict(
      rootsBoundProblems(decls, bindings),
      "Declare `export const <root> = defineFileRoot({ id, dir })` in the owning plugin's server/ and contribute " +
        "`FileRootLocation(<root>, <its DataDir>)` from that plugin's machine/index.ts.",
    );
  },
};

const rootOwner: Check = {
  id: "data-files:root-owner",
  description:
    "a file root's dir is a data dir declared by the declaring plugin or one of its ancestors — a plugin reaches only files its own subtree owns",
  async run(ctx) {
    const repo = await ctx.repo();
    const decls = await rootDeclarations(repo.root);
    // Each candidate owner's declared dirs, from its evaluated data-dirs
    // barrel: an app's dir is spelled from its identity, never as a literal.
    const declared = new Map<string, ReadonlySet<string>>();
    for (const d of decls) {
      for (const plugin of selfAndAncestors(d.plugin)) {
        if (!declared.has(plugin)) {
          const file = `plugins/${plugin}/data-dirs/index.ts`;
          const dirs = new Set<string>();
          if (repo.has(file)) {
            const mod = (await import(join(repo.root, file))) as {
              default: unknown;
            };
            const items = Array.isArray(mod.default)
              ? (mod.default as unknown[])
              : [mod.default];
            for (const item of items) {
              const spec = (
                item as { spec?: { kind?: unknown; name?: unknown } }
              ).spec;
              if (
                typeof spec?.kind !== "string" ||
                typeof spec.name !== "string"
              ) {
                throw new Error(
                  `[data-files:root-owner] ${file} default-exports something that is not a DataDir`,
                );
              }
              dirs.add(`${spec.kind}/${spec.name}`);
            }
          }
          declared.set(plugin, dirs);
        }
      }
    }
    return verdict(
      rootOwnerProblems(decls, (p) => declared.get(p) ?? new Set()),
      "A root names a data dir its own plugin or an ancestor declares in data-dirs/index.ts (an app's sub-plugin " +
        "names the app's dir, `apps/<app>`; re-derivable output gets its own `cache/` dir).",
    );
  },
};

export default [rootsBound, rootOwner];
