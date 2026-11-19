// `core/` here means runtime-neutral Node, not web-safe: it spawns nothing and
// reads nothing itself (the caller hands it a runner and an `exists`), but what
// it describes — a systemd user manager — exists only on a Linux host.

export type {
  ScopeCommandRunner,
  ScopedCommand,
  ScopeOomdKill,
  UserScopeHost,
} from "./internal/scope";
export { inOwnScope, readScopeOomdKill, userScopeHost } from "./internal/scope";
