import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  buildRegistryGenContext,
  deriveBrowserHostGraph,
  discoverBrowserHosts,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import {
  loadConfigRegistrations,
  type ConfigRegistration,
} from "./config-registrations";

const HOST_PAIRED = "config-v2:host-registrations-paired";

/** A graph member's plugin path (`a/plugins/b`) as its dot id (`a.b`). */
const memberId = (pluginPath: string): string =>
  pluginPath.split("/plugins/").join(".");

/**
 * The browser-host twin of `config-v2:registrations-paired`. A page scoped to a
 * browser host (`<PluginScope composition={browserHost}>`) renders exactly the
 * host's web plugins, and its config reads are answered by the host's WORKER —
 * which boots only the graph's portable `server/` barrels, never a `machine/`
 * half. So every `ConfigV2.WebRegister` a scoped web plugin contributes needs a
 * `ConfigV2.Register` at the same storePath in a graph member's `server/`
 * barrel, or `useConfig` throws "registered on web but the server has no
 * matching ConfigV2.Register" inside the demo.
 *
 * Keyed by the REGISTERING plugin (the barrel's): reorder registers one
 * directive per slot under the declaring plugin's id, and what decides whether
 * the page registers it is whether reorder's own web barrel is in the scope.
 * The descriptor's OWNER must be in the scope too: a directive for a slot no
 * scoped plugin declares (e.g. one of `review/plugin-changes`, which no
 * composition ships) is never read inside the scope.
 *
 * Exemptable per registrar: a plugin whose `ConfigV2.Register` cannot join the
 * worker yet (its server barrel is not portable, or it sits in `machine/`)
 * declares a debt exemption naming the barrel holding that Register — and the
 * exemption goes stale the moment the barrel joins the graph.
 */
export const hostRegistrationsPairedCheck: Check = {
  id: HOST_PAIRED,
  description:
    "every ConfigV2.WebRegister of a web plugin a browser host scopes its page to has a ConfigV2.Register at the same storePath in a `server/` barrel of the host's worker graph",
  exemptable: {
    [HOST_PAIRED]:
      "registers config a browser host's scoped page reads, from a barrel the host's worker does not boot (not portable yet, or in `machine/`) — the demo cannot read it",
  },
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    const gen = await buildRegistryGenContext(repo.root, repo);
    const hosts = discoverBrowserHosts(repo);
    if (hosts.length === 0) return { ok: true };

    const loaded = await loadConfigRegistrations(gen);
    if (!loaded.ok) return loaded;
    const exempt = await ctx.exempt(HOST_PAIRED);

    const serverSide = new Map<string, ConfigRegistration[]>();
    for (const r of loaded.registrations) {
      if (r.runtime === "web") continue;
      serverSide.set(r.storePath, [...(serverSide.get(r.storePath) ?? []), r]);
    }

    const failures: string[] = [];
    for (const host of hosts) {
      const graph = await deriveBrowserHostGraph(gen, host);
      const scope = new Set<string>(graph.webPlugins);
      const members = new Set(graph.members.map(memberId));

      // storePath → the scoped web registrars reading it.
      const required = new Map<string, string[]>();
      for (const r of loaded.registrations) {
        if (
          r.runtime !== "web" ||
          !scope.has(r.registrar) ||
          !scope.has(r.owner)
        )
          continue;
        required.set(r.storePath, [
          ...(required.get(r.storePath) ?? []),
          r.registrar,
        ]);
      }

      // barrel → the storePaths it fails to serve the host, with the reason.
      const unserved = new Map<string, { why: string; paths: string[] }>();
      const note = (barrel: string, why: string, path: string): void => {
        const entry = unserved.get(barrel) ?? { why, paths: [] };
        entry.paths.push(path);
        unserved.set(barrel, entry);
      };
      for (const [path, webRegistrars] of [...required].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const sites = serverSide.get(path) ?? [];
        const served = sites.some(
          (s) => s.runtime === "server" && members.has(s.registrar),
        );
        if (served) continue;
        if (sites.length === 0) {
          // No server half at all — `config-v2:registrations-paired`'s finding
          // too; named here against the web barrel(s) reading it.
          for (const w of webRegistrars) {
            note(`web barrel of ${w}`, "no ConfigV2.Register anywhere", path);
          }
          continue;
        }
        if (sites.some((s) => exempt.skips(s.barrel))) continue;
        for (const s of sites) {
          note(
            s.barrel,
            s.runtime === "machine"
              ? "a `machine/` barrel, which no browser host boots"
              : "a `server/` barrel outside the worker graph (not `portable: true`, or its plugin is not in the composition)",
            path,
          );
        }
      }

      if (unserved.size === 0) continue;
      failures.push(
        `${host.declaration} (composition "${graph.composition}"): ${[...unserved.values()].reduce((n, e) => n + e.paths.length, 0)} config storePath(s) its scoped page registers are not served by its worker:\n` +
          [...unserved]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(
              ([barrel, { why, paths }]) =>
                `    ${barrel} — ${why}:\n${paths.map((p) => `      ${p}`).join("\n")}`,
            )
            .join("\n"),
      );
    }

    if (failures.length === 0) return { ok: true };
    return {
      ok: false,
      message: failures.join("\n  "),
      hint:
        "Make the registering `server/` barrel `portable: true` (its closure must pass `boundaries:portable-closure`), " +
        "or move the `ConfigV2.Register` from `machine/` into the plugin's portable `server/` barrel. When that is not " +
        'trivial yet, the registrar declares a `kind: "debt"` exemption for this check in its own `exempt/index.ts`, ' +
        "naming the barrel and the follow-up task.",
    };
  },
};
