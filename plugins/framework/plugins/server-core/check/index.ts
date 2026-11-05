import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  asFsPath,
  isTestCodePath,
  PLUGIN_FOLDERS,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  buildRegistryGenContext,
  renderBackendEntry,
  codegenPassOver,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import {
  backendEntryFor,
  SERVER_CORE_RELATIVE,
} from "@plugins/infra/plugins/paths/core";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { serverPortabilityOf } from "@plugins/framework/plugins/tooling/plugins/boundaries/core";
import {
  hostServicesByName,
  parseHostServiceDeclarations,
  providedServiceNames,
  type HostServiceDecl,
} from "@plugins/plugin-meta/plugins/parse-utils/core";

const BARREL_RE =
  /^plugins\/[^/]+(?:\/plugins\/[^/]+)*\/(server|machine)\/index\.ts$/;
/** A file's `<plugin dir>/<first folder>` (the folder kind is checked by name). */
const PLUGIN_FOLDER_RE = /^(plugins\/[^/]+(?:\/plugins\/[^/]+)*\/[^/]+)\//;
/** The plugin folder of a module under a `server/` half (`null` for any other folder). */
const SERVER_MODULE_RE = /^(plugins\/[^/]+(?:\/plugins\/[^/]+)*)\/server\//;

/**
 * Where a host service's providers sit — the placement both hosts depend on.
 * A desktop backend boots every plugin of its composition, so it must ship
 * exactly one provider of each service, from a `machine/` half. A plugin whose
 * portable `server/` provides a service is a HOST PROVIDER
 * (`EdgeGraph.hostProviders`): resolution keeps it out of every composition by
 * that fact alone, and a browser host picks its providers from them — so each
 * service a browser host can reach needs exactly one. Portability is derived
 * (`serverPortabilityOf`), and a service no portable `server/` barrel provides
 * taints the module declaring it, so a service declared in a `server/` half is
 * reachable exactly when its barrel stays portable — the two rules agree by
 * construction.
 *
 * What keeps the derivation honest, since it removes a plugin from every app
 * on a text fact:
 * - every host provider is portable (a tainted one would drop out of the
 *   browser candidates silently, leaving only "0 providers" with no chain);
 * - every binding a `server/` barrel calls `.provide(` on names a declared host
 *   service (any other `.provide(` would exclude the plugin by mistake);
 * - a host provider is a `server/` barrel and nothing else — no other plugin
 *   folder (barrel or leaf), no sub-plugin, and no shipped importer — since
 *   leaving every composition takes all of those with it.
 */
const check: Check = {
  id: "host-services:provider-placement",
  description:
    "every host service has exactly one `machine/` provider; one declared in a portable `server/` barrel also has exactly one host provider (a plugin whose `server/index.ts` provides it); every host provider is portable, provides only declared host services, and is a lone `server/` barrel nothing imports",
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    const gen = await buildRegistryGenContext(codegenPassOver(repo));
    const portability = await serverPortabilityOf(repo);

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
    const problems: string[] = [];
    for (const path of repo.all()) {
      const m = BARREL_RE.exec(path);
      if (m === null) continue;
      const src = (await repo.read(path)) ?? "";
      const names = providedServiceNames(src);
      if (names.length === 0) continue;
      const services = names
        .map((n) => byName.get(n))
        .filter((d) => d !== undefined);
      if (m[1] === "machine") {
        for (const d of services)
          machine.set(d.id, [...(machine.get(d.id) ?? []), path]);
        continue;
      }
      const unknown = names.filter((n) => !byName.has(n));
      if (unknown.length > 0) {
        problems.push(
          `${path} calls ${unknown.map((n) => `${n}.provide(…)`).join(", ")}, which names no declared host service — a \`server/\` barrel that calls \`.provide(\` is read as a host provider and kept out of every composition`,
        );
      }
      if (!portability.isPortable(path)) {
        problems.push(
          `${path} is a host provider (its \`server/index.ts\` provides ${services.map((d) => `"${d.id}"`).join(", ")}), but it is not portable:\n    ${portability
            .offenders(path)
            .map(
              (o) =>
                `${o.module} needs ${o.needs.join(", ")}\n      via ${o.chain.join(" → ")}`,
            )
            .join("\n    ")}`,
        );
        continue;
      }
      for (const d of services)
        browser.set(d.id, [...(browser.get(d.id) ?? []), path]);
    }

    // A host provider leaves every composition with its subtree and its
    // importers: nothing may ride along.
    const folders = new Set<string>();
    for (const path of repo.all()) {
      const m = PLUGIN_FOLDER_RE.exec(path);
      if (m !== null) folders.add(m[1]!);
    }
    for (const [id] of gen.graph.hostProviders) {
      const dir = `plugins/${asFsPath(id)}`;
      // Every plugin folder but `server/` — a barrel, or a leaf a collected
      // registry reads per composition (`check/`, `data-dirs/`, `cli/`, …).
      const halves = PLUGIN_FOLDERS.filter(
        (f) => f !== "server" && folders.has(`${dir}/${f}`),
      );
      if (halves.length > 0) {
        problems.push(
          `${dir} is a host provider, so no composition bundles it — yet it has ${halves.map((h) => `\`${h}/\``).join(", ")}, which would leave every app with it. Move that code to the plugin that owns the service.`,
        );
      }
      const children = gen.graph.subtree.get(id) ?? [];
      if (children.length > 0) {
        problems.push(
          `${dir} is a host provider, so no composition bundles it — yet it has sub-plugins (${children.join(", ")}), which would leave every app with it.`,
        );
      }
      const importers = gen.graph.hardReverse.get(id) ?? [];
      if (importers.length > 0) {
        problems.push(
          `${dir} is a host provider, so no composition bundles it — yet ${importers.join(", ")} import${importers.length === 1 ? "s" : ""} it, and would leave every app with it. Import the service's owner instead; a host picks its provider.`,
        );
      }
    }

    // A service declared outside a `server/` half (core runs on every host)
    // is conservatively reachable by a browser host.
    const browserReachable = (module: string): boolean => {
      const m = SERVER_MODULE_RE.exec(module);
      if (m === null) return true;
      const barrel = `${m[1]}/server/index.ts`;
      return repo.has(barrel) && portability.isPortable(barrel);
    };

    for (const d of [...byName.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const required: (readonly [string, string[]])[] = [
        ["`machine/` provider", machine.get(d.id) ?? []],
      ];
      if (browserReachable(d.module))
        required.push(["host provider", browser.get(d.id) ?? []]);
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
        "A host service has one provider per host: the desktop's in the plugin's `machine/` half, the browser's in a host provider — " +
        "a sub-plugin whose portable `server/index.ts` is just `contributions: [<Service>.provide(…)]`, which no composition bundles " +
        "(see the host-services section of plugins/framework/plugins/server-core/CLAUDE.md).",
    };
  },
};

/**
 * The main composition's serving entry (`bin/index.ts`) is exactly what codegen
 * renders for it (`renderBackendEntry`) — the same template every other
 * composition's gitignored entry is written from. Two reasons: a hand edit to
 * the committed entry would silently not reach any other composition's, and
 * the generated ones are outside the tsc program, so the committed one is how
 * the template's contract with `bin/serve.ts` gets type-checked at all.
 */
const backendEntryInSync: Check = {
  id: "server-core:backend-entry-in-sync",
  description:
    "the main composition's serving entry (server-core bin/index.ts) is byte-identical to codegen's renderBackendEntry, the template every composition's entry is written from",
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    const rel = `${SERVER_CORE_RELATIVE}/${backendEntryFor(MAIN_COMPOSITION_ID)}`;
    const want = renderBackendEntry(MAIN_COMPOSITION_ID);
    if ((await repo.read(rel)) === want) return { ok: true };
    return {
      ok: false,
      message: `${rel} differs from renderBackendEntry's output for the main composition.`,
      hint:
        "Edit the template (renderBackendEntry, plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts), not the file, then copy its render into bin/index.ts; " +
        "anything the backend does beyond importing its registries belongs in bin/serve.ts.",
    };
  },
};

export default [check, backendEntryInSync];
