import { HttpError } from "@plugins/infra/plugins/endpoints/server";

/**
 * The typed failure of every SSH-key path in this plugin, plus the single place
 * user-facing copy for it exists.
 *
 * Its own module rather than living beside `derivePublicKey`, because both the
 * public-key parser and the `ssh-keygen` wrapper throw it and the wrapper reads
 * the parser — one direction of dependency instead of a cycle.
 */
export type InvalidSshKeyReason =
  | "public-key-pasted"
  | "passphrase-protected"
  | "not-a-private-key"
  | "unsupported-format";

export class InvalidSshKeyError extends Error {
  constructor(
    readonly reason: InvalidSshKeyReason,
    message: string,
  ) {
    super(message);
    this.name = "InvalidSshKeyError";
  }
}

/**
 * Copy for a rejected key. The reason classification is derived from
 * `ssh-keygen`'s stderr and so is version-sensitive across OpenSSH releases —
 * acceptable only because a misclassification degrades this copy to the generic
 * branch (which still carries the raw stderr) and never the failure signal.
 */
export function userMessage(err: InvalidSshKeyError): string {
  switch (err.reason) {
    case "public-key-pasted":
      return "That's the public half. Paste the private key — the file starting with `-----BEGIN OPENSSH PRIVATE KEY-----`, not the `.pub` one.";
    case "passphrase-protected":
      return 'This key is passphrase-protected. equin connects unattended and has no one to type a passphrase. Paste a key made without one (`ssh-keygen -t ed25519 -N ""`), or generate one here.';
    case "not-a-private-key":
    case "unsupported-format":
      return `\`ssh-keygen\` couldn't read that as a private key: ${err.message}`;
  }
}

/**
 * `.catch(rejectInvalidKey)` — a key the user got wrong is a 400 carrying the
 * message above; every other failure (a missing `ssh-keygen`, an unwritable
 * tmpdir, the secrets store being down) propagates as the 500 it is.
 */
export function rejectInvalidKey(err: unknown): never {
  if (err instanceof InvalidSshKeyError) {
    throw new HttpError(400, userMessage(err));
  }
  throw err;
}
