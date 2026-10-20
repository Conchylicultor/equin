import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { existsSync } from "fs";
import { join, relative } from "path";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  registerBarrelStubs,
  importBarrel,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import {
  buildRegistryGenContext,
  declareSlotsFromBarrels,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

// A config descriptor is stored under `${asPath(pluginId)}/${descriptor.name}.jsonc`,
// where `pluginId` is the contribution's explicit `pluginId` override (a plugin
// can plant a descriptor under ANOTHER plugin's hierarchy — e.g. reorder) else
// the registering plugin's own loader-injected id (the node's own dotted `id`).
// Both are dotted `PluginId`s; the on-disk store path is the slash form, so
// mirror `registry.ts` exactly by converting through `asPath`.
function storePathFor(
  override: string | undefined,
  fallbackId: string,
  descriptorName: string,
): string {
  return `${asPath(asPluginId(override ?? fallbackId))}/${descriptorName}.jsonc`;
}

const WEB_REGISTER_SLOT_ID = "config_v2.web-register";

/** The barrels whose `ConfigV2.Register` contributions make the server half. */
const SERVER_HALF_RUNTIMES = ["server", "machine"] as const;

type BarrelContribution = Record<string, unknown> & {
  _slot?: SlotHandle;
  _kind?: symbol;
  pluginId?: string;
  descriptor?: { name?: string };
};

const check: Check = {
  id: "config-v2:registrations-paired",
  description:
    "Every ConfigV2.Register (server/ or machine/) must have a matching ConfigV2.WebRegister (web) at the same storePath, and vice versa",
  async run() {
    const root = await getWorktreeRoot();
    const pluginsRoot = join(root, "plugins");

    // The shared registry-gen context: its memoized barrel-free tree is the same
    // node set this check walks, and its `mainBundle` is the app's membership —
    // both already built by the other checks in the run, so taking them here
    // costs nothing and cannot disagree with what codegen emitted.
    const ctx = await buildRegistryGenContext(root);
    const tree = ctx.tree;
    registerBarrelStubs(join(pluginsRoot, ".."));

    // Importing a web barrel is only HALF of loading the web runtime. A plugin
    // that derives its contributions from the slot DECLARATIONS (reorder mints
    // one config descriptor per reorderable slot, under the plugin that declared
    // it) has an empty `contributions` array until a declaration pass has run —
    // `PluginProvider` runs one before it reads any plugin's contributions, and
    // this is the build-time twin of that pass, over the same registry the
    // browser would load. Without it this check compares a real server set
    // against an empty web set and reports every reorder descriptor as unpaired.
    const naming = await declareSlotsFromBarrels(root, "registry");

    // Resolved ONCE, here, then compared by IDENTITY in the loop below. The id
    // is derived — the plugin directory is `config_v2` (underscore) and the slot
    // is declared under the key `WebRegister`, so it is `config_v2.web-register`,
    // NOT the hand-authored `config-v2.web-register` this check used to spell.
    // A stale id now fails at this one named line instead of matching nothing
    // and reporting every server registration as unpaired.
    //
    // `findSlot`, never `slotNamed`: the runner awaits every check under
    // `Promise.all` and rethrows, so a throw here would kill every OTHER check's
    // reporting. A miss is this check's own failure value.
    const webRegisterSlot = naming.findSlot(WEB_REGISTER_SLOT_ID);
    if (webRegisterSlot === undefined) {
      return {
        ok: false,
        message:
          `No slot is declared under "${WEB_REGISTER_SLOT_ID}" in the registry-scoped ` +
          `declaration pass, so this check can pair nothing. Either the slot moved ` +
          `(an id derives from its declaring plugin's id plus its \`slots\` key) or ` +
          `config_v2's web barrel failed to declare it.`,
      };
    }

    const webPaths = new Set<string>();
    const serverPaths = new Set<string>();

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
    const ownerExcluded = (override: string | undefined, fallback: string) =>
      !ctx.mainBundle.has(asPluginId(override ?? fallback));

    for (const node of tree.byDir.values()) {
      const fallbackId = node.id;

      const webIndex = join(node.dir, "web", "index.ts");
      if (existsSync(webIndex)) {
        let mod: Record<string, unknown>;
        try {
          mod = await importBarrel(webIndex);
        } catch (err) {
          return {
            ok: false,
            message: `Failed to import web barrel ${relative(root, webIndex)}: ${String(err)}`,
          };
        }
        const def = mod.default as
          { contributions?: BarrelContribution[] } | undefined;
        for (const c of def?.contributions ?? []) {
          if (c._slot !== webRegisterSlot) continue;
          const name = c.descriptor?.name;
          if (typeof name !== "string") continue;
          if (ownerExcluded(c.pluginId, fallbackId)) continue;
          webPaths.add(storePathFor(c.pluginId, fallbackId, name));
        }
      }

      // The server half is the server/ barrel OR the machine/ one: a plugin
      // made portable keeps its config registration on the computer
      // (`machine/`), whose contributions boot are collected exactly like
      // server/'s.
      for (const runtime of SERVER_HALF_RUNTIMES) {
        const serverIndex = join(node.dir, runtime, "index.ts");
        if (!existsSync(serverIndex)) continue;
        let mod: Record<string, unknown>;
        try {
          mod = await importBarrel(serverIndex);
        } catch (err) {
          return {
            ok: false,
            message: `Failed to import ${runtime} barrel ${relative(root, serverIndex)}: ${String(err)}`,
          };
        }
        const def = mod.default as
          { contributions?: BarrelContribution[] } | undefined;
        for (const c of def?.contributions ?? []) {
          // Web contributions also live in def.contributions on the web side,
          // but the server `contributions[]` are ServerContributions tagged by
          // a `_kind` symbol. Positively identify config registrations by that
          // symbol's description rather than "has a descriptor".
          if (c._kind?.description !== "ConfigV2.Register") continue;
          const name = c.descriptor?.name;
          if (typeof name !== "string") continue;
          if (ownerExcluded(c.pluginId, fallbackId)) continue;
          serverPaths.add(storePathFor(c.pluginId, fallbackId, name));
        }
      }
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
