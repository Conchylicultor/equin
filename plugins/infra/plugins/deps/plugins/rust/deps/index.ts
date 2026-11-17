// The rust installer kind of infra/deps, host-only like the engine and built
// on the build kind: a declaration of a plugin's `rust/` crate (`cargoBuild`,
// in a feature's `deps/index.ts`), the path of its binary once installed
// (`cargoBinary`, which takes a `Ready`), and the one spelling of a cargo
// command outside the kind (`cargoCommand`, `cargoEnv`) — the cargo updater's.
export {
  cargoBinary,
  cargoBuild,
  cargoBuildArgv,
  cargoCommand,
  cargoEnv,
} from "./internal/cargo";
export { crateCheckTargetDir, crateTargetDir } from "./internal/target-dir";
export type { CargoBuildSpec, CargoSource } from "./internal/cargo";
