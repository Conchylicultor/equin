import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { sshRun } from "./internal/run";
export { sshUpload } from "./internal/upload";
export { materializeHermetic } from "./internal/session";
export type { HermeticHandle } from "./internal/session";
export { sshTunnelArgv } from "./internal/tunnel";
export type { SshForward } from "./internal/tunnel";
export {
  classifyTunnelStderr,
  classifyTunnelStderrLine,
  tunnelFailureMessage,
} from "./internal/classify";
export type {
  SshTarget,
  SshRunResult,
  SshUploadResult,
  SshFailure,
} from "./internal/types";

export default {
  description:
    "Hermetic SSH client primitive: sshRun (one remote command) and sshUpload (one file, over scp) open a session to (host, port, user) with EXACTLY the private key they are given — IdentitiesOnly + IdentityAgent=none + -F /dev/null keep the machine's own agent, config and multiplexed sessions out, so a connection test proves the key it was handed works — and return a discriminated result whose failures are classified from OpenSSH stderr (dns / unreachable / timeout / auth / host-key-mismatch / command-failed / unknown). Both are built from one shared hermetic invocation, so the isolation flags cannot drift between them. Host-key policy is pinned-or-learn with no 'off'; the key is materialized 0600 into a mkdtemp dir removed in finally. A long-lived ssh is built from the same block: materializeHermetic returns a caller-owned handle (the scratch dir with key and pinned known_hosts, its argv builder, dispose), sshTunnelArgv turns it into a forward-only ssh (-N, local Unix socket → remote loopback TCP port, ExitOnForwardFailure, 15 s keep-alives, StreamLocalBindUnlink; socket paths under macOS's 104-byte sun_path, asserted), and classifyTunnelStderr / classifyTunnelStderrLine read its stderr into its own vocabulary (adds forwarding-refused and disconnected; tunnelFailureRetryable in core says which a respawn can fix). An upload lands on a staging sibling and is renamed over its destination, so it can neither fail because the destination is being executed nor leave a truncated file where a working one was.",
} satisfies ServerPluginDefinition;
