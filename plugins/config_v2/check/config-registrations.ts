import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { existsSync } from "fs";
import { join, relative } from "path";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  registerBarrelStubs,
  importBarrel,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import {
  declareSlotsFromBarrels,
  type RegistryGenContext,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";

/** The runtime a config registration was found in. */
export type RegistrationRuntime = "web" | "server" | "machine";

/** One `ConfigV2.WebRegister` / `ConfigV2.Register` contribution, located. */
export interface ConfigRegistration {
  runtime: RegistrationRuntime;
  /** The plugin whose barrel contributes it (dot id). */
  registrar: string;
  /**
   * The plugin the descriptor is stored under: the contribution's `pluginId`
   * override (reorder plants one directive per slot under the slot's declaring
   * plugin) else the registrar.
   */
  owner: string;
  /** `${asPath(owner)}/${descriptor.name}.jsonc` — the registry's own spelling. */
  storePath: string;
  /** Repo-relative barrel the contribution was found in. */
  barrel: string;
}

/** A barrel's default export, as read by {@link collectConfigRegistrations}. */
export interface RegistrationBarrel {
  runtime: RegistrationRuntime;
  /** The barrel's plugin (dot id). */
  pluginId: string;
  /** Repo-relative barrel path. */
  barrel: string;
  contributions: readonly unknown[];
}

type BarrelContribution = {
  _slot?: SlotHandle;
  _kind?: symbol;
  pluginId?: string;
  descriptor?: { name?: string };
};

// A config descriptor is stored under `${asPath(pluginId)}/${descriptor.name}.jsonc`,
// where `pluginId` is the contribution's explicit `pluginId` override else the
// registering plugin's own loader-injected id. Both are dotted `PluginId`s; the
// on-disk store path is the slash form, so mirror `registry.ts` exactly by
// converting through `asPath`.
function storePathFor(owner: string, descriptorName: string): string {
  return `${asPath(asPluginId(owner))}/${descriptorName}.jsonc`;
}

/**
 * Every config registration of the given barrels — pure over their loaded
 * contributions. A web registration is a contribution to the `WebRegister`
 * slot (compared by IDENTITY against the declaration pass's handle); a
 * server/machine one is a `ServerContribution` whose `_kind` symbol is
 * `ConfigV2.Register` (web contributions carry a `_slot`, never that symbol).
 *
 * The one reading both pairing checks share — `config-v2:registrations-paired`
 * (web ⇄ server/machine, over the app's bundle) and
 * `config-v2:host-registrations-paired` (a browser host's scope ⇄ its worker
 * graph) — so the two cannot disagree on what a registration is.
 */
export function collectConfigRegistrations(
  barrels: readonly RegistrationBarrel[],
  webRegisterSlot: SlotHandle,
): ConfigRegistration[] {
  const out: ConfigRegistration[] = [];
  for (const b of barrels) {
    for (const raw of b.contributions) {
      const c = raw as BarrelContribution;
      const isRegistration =
        b.runtime === "web"
          ? c._slot === webRegisterSlot
          : c._kind?.description === "ConfigV2.Register";
      if (!isRegistration) continue;
      const name = c.descriptor?.name;
      if (typeof name !== "string") continue;
      const owner = c.pluginId ?? b.pluginId;
      out.push({
        runtime: b.runtime,
        registrar: b.pluginId,
        owner,
        storePath: storePathFor(owner, name),
        barrel: b.barrel,
      });
    }
  }
  return out;
}

const WEB_REGISTER_SLOT_ID = "config_v2.web-register";

const RUNTIMES: readonly RegistrationRuntime[] = ["web", "server", "machine"];

/**
 * Import every plugin's web, server and machine barrel (stubbed, after the
 * registry-scoped slot declaration pass) and collect their config
 * registrations. A failure is a value, never a throw: the runner awaits every
 * check under `Promise.all`, so a throw here would kill every other check's
 * reporting.
 */
export async function loadConfigRegistrations(
  ctx: RegistryGenContext,
): Promise<
  | { ok: true; registrations: ConfigRegistration[] }
  | { ok: false; message: string }
> {
  const root = ctx.root;
  registerBarrelStubs(root);

  // Importing a web barrel is only HALF of loading the web runtime. A plugin
  // that derives its contributions from the slot DECLARATIONS (reorder mints
  // one config descriptor per reorderable slot, under the plugin that declared
  // it) has an empty `contributions` array until a declaration pass has run —
  // `PluginProvider` runs one before it reads any plugin's contributions, and
  // this is the build-time twin of that pass, over the same registry the
  // browser would load.
  const naming = await declareSlotsFromBarrels(root, "registry");

  // The id is derived — the plugin directory is `config_v2` (underscore) and
  // the slot is declared under the key `WebRegister`, so it is
  // `config_v2.web-register`. A stale id fails at this one named line instead
  // of matching nothing. `findSlot`, never `slotNamed`: a miss is a failure
  // value (see above).
  const webRegisterSlot = naming.findSlot(WEB_REGISTER_SLOT_ID);
  if (webRegisterSlot === undefined) {
    return {
      ok: false,
      message:
        `No slot is declared under "${WEB_REGISTER_SLOT_ID}" in the registry-scoped ` +
        `declaration pass, so no registration can be collected. Either the slot moved ` +
        `(an id derives from its declaring plugin's id plus its \`slots\` key) or ` +
        `config_v2's web barrel failed to declare it.`,
    };
  }

  const barrels: RegistrationBarrel[] = [];
  for (const node of ctx.tree.byDir.values()) {
    for (const runtime of RUNTIMES) {
      const index = join(node.dir, runtime, "index.ts");
      if (!existsSync(index)) continue;
      let mod: Record<string, unknown>;
      try {
        mod = await importBarrel(index);
      } catch (err) {
        return {
          ok: false,
          message: `Failed to import ${runtime} barrel ${relative(root, index)}: ${String(err)}`,
        };
      }
      const def = mod.default as { contributions?: unknown[] } | undefined;
      barrels.push({
        runtime,
        pluginId: node.id,
        barrel: relative(root, index),
        contributions: def?.contributions ?? [],
      });
    }
  }
  return {
    ok: true,
    registrations: collectConfigRegistrations(barrels, webRegisterSlot),
  };
}
