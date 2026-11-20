// Web-safe half of the SSH primitive: the classified failure vocabulary and the
// tunnel target (its remote host and the authorized_keys options that allow it),
// so the browser can key remediation copy off a kind without pulling in
// `node:fs` / the spawn primitive. The client half of the plugin is this and
// nothing else — running ssh is `server/` only.

export {
  SshFailureKindSchema,
  SshTunnelFailureKindSchema,
  tunnelFailureRetryable,
} from "./failure-kind";
export type { SshFailureKind, SshTunnelFailureKind } from "./failure-kind";
export { TUNNEL_KEY_OPTIONS, TUNNEL_REMOTE_HOST } from "./tunnel-target";
