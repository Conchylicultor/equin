// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: the updater spawns
// mise. It lives in `core/` so `./singularity toolchain upgrade` (the alias)
// runs it without booting a backend. It must NEVER be imported from `web/`.
export { miseUpdater } from "./internal/mise-updater";
// What `build` and `start` run before the prerequisite doctor, so a lock that
// arrived without its installs (a clone, a pull) is installed, not reported.
export { installLockedToolchain } from "./internal/install-locked";
