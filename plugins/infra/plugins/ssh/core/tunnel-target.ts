/**
 * Where a tunnel's forwards land on the remote host: its loopback, literally
 * this address (`-L <socket>:127.0.0.1:<port>`). sshd's `permitopen` does no
 * name lookup, so the key option below must spell the very same literal — one
 * constant for both, so they cannot drift.
 */
export const TUNNEL_REMOTE_HOST = "127.0.0.1";

/**
 * The `authorized_keys` options that let a key carry a tunnel and nothing
 * more: after `restrict` (which forbids every forwarding), `port-forwarding`
 * turns local forwards back on and `permitopen` confines them to the remote
 * loopback, any port — the box's own services, which the key's shell can
 * reach anyway, never a pivot to another host. Append to `restrict,…`.
 */
export const TUNNEL_KEY_OPTIONS = `port-forwarding,permitopen="${TUNNEL_REMOTE_HOST}:*"`;
