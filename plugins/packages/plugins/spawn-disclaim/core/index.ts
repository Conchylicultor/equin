// The FFI-free, import-free half: the argv shape of a disclaimed spawn. The
// helper itself is the `disclaimExec` dependency (`deps/` barrel).
export {
  disclaimArgv,
  NO_SPAWN_DISCLAIM_ENV,
  spawnDisclaimWanted,
} from "./internal/disclaim-argv";
