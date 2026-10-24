import type { Hold } from "@plugins/infra/plugins/deps/plugins/updates/core";

/** Where {@link CARGO_HOLDS} is declared, named in a hold's messages. */
export const CARGO_HOLDS_FILE =
  "plugins/infra/plugins/deps/plugins/rust/plugins/cargo-updater/core/internal/holds.ts";

/**
 * Releases not to move to, as the shared bounded `Hold` of infra/deps/updates.
 * `names` are crate names (as `Cargo.lock` spells them). Added by the agent
 * running a `cargo` upgrade when a new release regresses something that is not
 * ours to fix, with the reason, the upstream issue and a `reviewBy` at most 90
 * days out (`deps-cargo:holds`). Until a diff deletes it the updater never
 * plans a move onto a held release and detection lists it as HELD; past
 * `reviewBy` the upgrade refuses to run until it is lifted or renewed.
 */
export const CARGO_HOLDS: readonly Hold[] = [];
