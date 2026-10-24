import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { UpdaterDeclare } from "@plugins/infra/plugins/deps/plugins/updates/server";
import { cargoUpdater } from "./internal/cargo-updater";

// A sub-plugin of its own so the rust installer kind does not import the
// updater registry, which files tasks (the same split as python/uv-updater).

export default {
  description:
    "The `cargo` updater: moves every rust/ crate's Cargo.lock to the newest crates.io releases past a 3-day cooldown (within each Cargo.toml's requirements), contributed to the infra/deps updater registry.",
  contributions: [UpdaterDeclare({ updater: cargoUpdater })],
} satisfies ServerPluginDefinition;
