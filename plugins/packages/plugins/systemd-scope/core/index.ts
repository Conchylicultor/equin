// `core/` here means runtime-neutral Node, not web-safe: it spawns nothing and
// reads nothing itself (the caller hands it a runner and an `exists`), but what
// it describes — a systemd user manager — exists only on a Linux host.

export type {
  ScopeCommandRunner,
  ScopedCommand,
  ScopeOomdKill,
  UnprobedScopeHost,
  UserScopeHost,
} from "./internal/scope";
export {
  heavyCommandScope,
  inAppScope,
  inOwnScope,
  readScopeOomdKill,
  unprobedScopeHost,
  userScopeHost,
} from "./internal/scope";
export type { ScopeKind } from "./internal/scope-name";
export { appScopeOf, scopeUnitName } from "./internal/scope-name";
