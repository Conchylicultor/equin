// Web-safe half of the SSH primitive: only the classified failure vocabulary,
// so the browser can key remediation copy off a kind without pulling in
// `node:fs` / the spawn primitive. The client half of the plugin is this and
// nothing else — running ssh is `server/` only.

export {
  SshFailureKindSchema,
  SshTunnelFailureKindSchema,
  tunnelFailureRetryable,
} from "./failure-kind";
export type { SshFailureKind, SshTunnelFailureKind } from "./failure-kind";
