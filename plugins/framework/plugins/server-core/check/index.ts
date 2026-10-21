import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import {
  baseExclusionServerBarrels,
  buildRegistryGenContext,
  hostServicesByName,
  parseHostServiceDeclarations,
  providedServiceNames,
  readCompositionManifestsFromDisk,
  type HostServiceDecl,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { isPortableServerBarrel } from "@plugins/plugin-meta/plugins/parse-utils/core";

const BARREL_RE =
  /^plugins\/[^/]+(?:\/plugins\/[^/]+)*\/(server|machine)\/index\.ts$/;
/** The plugin folder of a module under a `server/` half (`null` for any other folder). */
const SERVER_MODULE_RE = /^(plugins\/[^/]+(?:\/plugins\/[^/]+)*)\/server\//;

/**
 * Where a host service's providers sit — the placement both hosts depend on.
 * A desktop backend boots every plugin of its composition, so it must ship
 * exactly one provider of each service, from a `machine/` half. A browser host
 * takes its providers from the `base-exclusions` negatives (no desktop ships
 * them), so a portable `server/` provider anywhere else would boot beside the
 * desktop's and fail `assertHostServices` — and each service a browser host
 * can reach needs exactly one such browser candidate, or the browser-host
 * derivation cannot pick one. A service declared in a non-portable `server/`
 * barrel is out of every browser host's reach (its consumers are not portable
 * either), so it needs no browser candidate until that barrel turns portable.
 */
const check: Check = {
  id: "host-services:provider-placement",
  description:
    "every host service has exactly one `machine/` provider; one declared in a portable `server/` barrel also has exactly one browser candidate (a portable `server/` barrel a `base-exclusions` negative names); and no portable `server/` barrel provides a service outside those negatives",
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    const gen = await buildRegistryGenContext(repo.root, repo);
    const negated = new Set(
      baseExclusionServerBarrels(
        gen.graph,
        readCompositionManifestsFromDisk(repo.root),
        (p) => repo.has(p),
      ),
    );

    const decls: (HostServiceDecl & { module: string })[] = [];
    for (const { rel, src } of await listCandidateSources({
      root: repo.root,
      grepArg: "defineHostService",
      fixed: true,
    })) {
      if (isTestCodePath(rel.split("/"))) continue;
      for (const d of parseHostServiceDeclarations(src)) {
        decls.push({ ...d, module: rel });
      }
    }
    const byName = hostServicesByName(decls);

    const machine = new Map<string, string[]>();
    const browser = new Map<string, string[]>();
    const misplaced: string[] = [];
    for (const path of repo.all()) {
      const m = BARREL_RE.exec(path);
      if (m === null) continue;
      const src = (await repo.read(path)) ?? "";
      const services = providedServiceNames(src)
        .map((n) => byName.get(n))
        .filter((d) => d !== undefined);
      if (services.length === 0) continue;
      if (m[1] === "machine") {
        for (const d of services)
          machine.set(d.id, [...(machine.get(d.id) ?? []), path]);
        continue;
      }
      if (!isPortableServerBarrel(src)) continue;
      if (!negated.has(path)) {
        misplaced.push(
          `${path} is portable and provides ${services.map((d) => `"${d.id}"`).join(", ")}, but no \`base-exclusions\` negative names it — every desktop composition would boot it beside the \`machine/\` provider`,
        );
        continue;
      }
      for (const d of services)
        browser.set(d.id, [...(browser.get(d.id) ?? []), path]);
    }

    // A service declared outside a `server/` half (core runs on every host)
    // is conservatively reachable by a browser host.
    const browserReachable = async (module: string): Promise<boolean> => {
      const m = SERVER_MODULE_RE.exec(module);
      if (m === null) return true;
      return isPortableServerBarrel(
        (await repo.read(`${m[1]}/server/index.ts`)) ?? "",
      );
    };

    const problems = [...misplaced];
    for (const d of [...byName.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const required: (readonly [string, string[]])[] = [
        ["`machine/` provider", machine.get(d.id) ?? []],
      ];
      if (await browserReachable(d.module))
        required.push(["browser candidate", browser.get(d.id) ?? []]);
      for (const [where, found] of required) {
        if (found.length === 1) continue;
        problems.push(
          `host service "${d.id}" (${d.module}) has ${found.length} ${where}s${found.length > 0 ? `: ${found.join(", ")}` : ""}`,
        );
      }
    }
    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message: problems.join("\n  "),
      hint:
        "A host service has one provider per host: the desktop's in the plugin's `machine/` half, the browser's in a portable " +
        "`server/` sub-plugin negated by the `base-exclusions` row (plugins/plugin-meta/plugins/composition/core/config.ts " +
        "and config/plugin-meta/composition/compositions.origin.jsonc).",
    };
  },
};

export default check;
