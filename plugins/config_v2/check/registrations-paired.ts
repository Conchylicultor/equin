import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { buildRegistryGenContext } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { loadConfigRegistrations } from "./config-registrations";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

const check: Check = {
  id: "config-v2:registrations-paired",
  description:
    "Every ConfigV2.Register (server/ or machine/) must have a matching ConfigV2.WebRegister (web) at the same storePath, and vice versa",
  async run() {
    const root = await getWorktreeRoot();

    // The shared registry-gen context: its memoized barrel-free tree is the same
    // node set this check walks, and its `mainBundle` is the app's membership —
    // both already built by the other checks in the run, so taking them here
    // costs nothing and cannot disagree with what codegen emitted.
    const ctx = await buildRegistryGenContext(root);
    const loaded = await loadConfigRegistrations(ctx);
    if (!loaded.ok) return loaded;

    // A plugin the app's composition does NOT bundle registers on neither
    // runtime: it is absent from the web registry the browser loads, and
    // `discoverConfigs` skips it server-side. So it must be absent from BOTH
    // sides here — and the test is the descriptor's OWNING plugin, not the barrel
    // it was found in: reorder registers every slot's directive from its own node
    // with an explicit `pluginId`, so an excluded plugin's directive arrives via a
    // bundled barrel.
    //
    // Membership is `singularity`'s resolved closure — the one answer to "is this
    // plugin in the app?", the same set every registry is filtered by.
    //
    // The server half is the server/ barrel OR the machine/ one: the desktop
    // boots both, collecting their contributions alike.
    const webPaths = new Set<string>();
    const serverPaths = new Set<string>();
    for (const r of loaded.registrations) {
      if (!ctx.mainBundle.has(asPluginId(r.owner))) continue;
      (r.runtime === "web" ? webPaths : serverPaths).add(r.storePath);
    }

    const webOnly = [...webPaths].filter((p) => !serverPaths.has(p)).sort();
    const serverOnly = [...serverPaths].filter((p) => !webPaths.has(p)).sort();

    if (webOnly.length === 0 && serverOnly.length === 0) return { ok: true };

    const parts: string[] = [];
    if (webOnly.length > 0) {
      parts.push(
        `${webOnly.length} config descriptor(s) registered on web (ConfigV2.WebRegister) but NOT on the server (no matching ConfigV2.Register in server/ or machine/) — these silently read back defaults at runtime:\n` +
          webOnly.map((p) => `    ${p}`).join("\n"),
      );
    }
    if (serverOnly.length > 0) {
      parts.push(
        `${serverOnly.length} config descriptor(s) registered on the server (ConfigV2.Register) but NOT on web (no matching ConfigV2.WebRegister) — useConfig throws for these at runtime:\n` +
          serverOnly.map((p) => `    ${p}`).join("\n"),
      );
    }

    return {
      ok: false,
      message: parts.join("\n\n"),
      hint: [
        webOnly.length > 0 &&
          "For each web-only storePath, add ConfigV2.Register({ descriptor }) (with the same pluginId override if used) to the defining plugin's server/index.ts or machine/index.ts contributions[].",
        serverOnly.length > 0 &&
          "For each server-only storePath, add ConfigV2.WebRegister({ descriptor }) (with the same pluginId override if used) to the defining plugin's web/index.ts contributions[].",
      ]
        .filter(Boolean)
        .join(" "),
    };
  },
};

export default check;
