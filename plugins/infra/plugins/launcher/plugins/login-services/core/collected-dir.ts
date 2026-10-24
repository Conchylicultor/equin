import { defineCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";

// Marks `login-services` as a collected dir: codegen scans core files for this
// marker and emits `login-services.generated.ts`, registering every plugin's
// `login-services/index.ts` whose default export is an array of
// `defineLoginService` values. Auto-discovered — a plugin declaring a login
// service needs no codegen edit, and `./equin start` / `stop` name none.
//
// Not re-exported from the `core` barrel: the registry's loaders reach
// host-only declarations (`deps`, `data-dirs`); `declaredLoginServices()`
// (`machine/`) is the one reader.
export const loginServicesCollectedDir = defineCollectedDir("login-services");
