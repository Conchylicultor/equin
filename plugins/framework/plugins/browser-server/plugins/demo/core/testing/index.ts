// The pack builders, for another plugin's test that mounts a scope over a
// small pack (the demo scope's own suite, a contributor's in-scope test).
// Until a shipping pack imports them, the public barrel's names have only
// test importers (R13), so tests take them from here.
export { definePack, packAll, packValue } from "../internal/pack";
export type { DemoPack } from "../internal/pack";
