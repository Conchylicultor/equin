import { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import { serverFields } from "../core";

/**
 * The SSH key this app holds for a server, carrying its own evidence.
 *
 * A non-null `sshKey` means exactly one thing: *we hold a private key AND know
 * which public key it corresponds to*. It deliberately does NOT claim the key
 * works — proving that is the `health` sub-plugin's job, and its verdict lives
 * in its own side-table. Because a status cannot be rendered without a
 * fingerprint, the "a secret row exists but we have no idea which key it is"
 * state is unrepresentable rather than merely unrendered.
 */
export const SshKeySchema = z.object({
  /** e.g. "ssh-ed25519" — read back out of the key blob, not assumed. */
  algorithm: z.string(),
  /** "SHA256:…" — byte-identical to what `ssh-keygen -lf` prints. */
  fingerprint: z.string(),
  comment: z.string(),
  /** The trimmed `authorized_keys` line, verbatim. */
  publicKey: z.string(),
});
export type SshKey = z.infer<typeof SshKeySchema>;

// The registry record: user-authored identity, address, credentials. Liveness
// is deliberately NOT here — reachability is probe-written state with a
// different writer and lifecycle, owned by the `health` sub-plugin's
// `deploy_servers_ext_health` side-table. Keeping a `status` column here beside
// a probe that owns the real verdict would be two sources of truth.
//
// The registry's fields are the entity's (`serverFields`); the derived `sshKey`
// (a secrets lookup beside `ssh_public_key`) joins them here, for the detail
// pane and the endpoints. The live list carries the fields alone — the key is
// read per server (`serverSshKey`).
export const ServerSchema = fieldsToZodObject(serverFields).extend({
  sshKey: SshKeySchema.nullable(),
});
export type Server = z.infer<typeof ServerSchema>;
