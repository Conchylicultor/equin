import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnCaptured,
  spawnExpectOk,
} from "@plugins/infra/plugins/spawn/core";
import { InvalidSshKeyError } from "./ssh-key-error";
import { parseSshPublicKey } from "./ssh-public-key";

// Both `ssh-keygen` calls run inside an HTTP request the user is waiting on,
// and both are pure local CPU over a 32-byte key — sub-second, with no network
// and (see the `-N ""` / `-P ""` note below) no prompt they can block on.
// Thirty seconds is the request's patience, not the command's expected cost.
const SSH_KEYGEN_TIMEOUT_MS = 30_000;

/**
 * Generates an ed25519 keypair by shelling out to `ssh-keygen` (present on
 * macOS/Linux), so both halves are in canonical OpenSSH format — the private
 * key is what an ssh client consumes, the public key is the exact
 * `ssh-ed25519 AAAA… comment` line an authorized_keys entry expects.
 * Throws (SpawnFailedError) on failure — never returns a partial pair.
 *
 * The empty passphrase (`-N ""`) is the correct choice, not a shortcut: this
 * daemon connects unattended, so any passphrase would have to be stored next to
 * the key — in the same encrypted secrets blob, under the same OS-keychain
 * master key. It would add zero attacker cost while making the key unusable by
 * the thing that needs it. Please don't "fix" it.
 */
export async function generateEd25519Keypair(
  comment: string,
): Promise<{ privateKey: string; publicKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sg-deploy-keygen-"));
  try {
    const keyPath = join(dir, "id_ed25519");
    await spawnExpectOk(
      ["ssh-keygen", "-t", "ed25519", "-f", keyPath, "-N", "", "-C", comment],
      { timeoutMs: SSH_KEYGEN_TIMEOUT_MS },
    );
    const [privateKey, publicKey] = await Promise.all([
      readFile(keyPath, "utf8"),
      readFile(`${keyPath}.pub`, "utf8"),
    ]);
    return { privateKey, publicKey: publicKey.trim() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Keeps a classified error's detail readable: drops ssh-keygen's `Load key
 * "<path>": ` prefix (our throwaway temp path, meaningless to the user) and
 * caps the length, since this ends up verbatim in the 400's copy.
 */
function stderrTail(stderr: string): string {
  const trimmed = stderr.trim().replace(/^Load key "[^"]*":\s*/gm, "");
  return trimmed.length > 200 ? `…${trimmed.slice(-200)}` : trimmed;
}

/**
 * Derives the `authorized_keys` line for a private key the user pasted, so a
 * row never holds a key we cannot identify — and so an unusable key is rejected
 * at the door instead of silently "succeeding".
 *
 * Throws `InvalidSshKeyError` for anything the user can fix; the caller maps it
 * to a 400. Any other failure (no `ssh-keygen`, unwritable tmpdir) propagates.
 */
export async function derivePublicKey(
  privateKey: string,
  comment: string,
): Promise<string> {
  // Pasting the `.pub` file is the single most likely mistake, and it deserves
  // a message that names it rather than ssh-keygen's generic format complaint.
  if (looksLikePublicKey(privateKey)) {
    throw new InvalidSshKeyError(
      "public-key-pasted",
      "the pasted text is an OpenSSH public key",
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "sg-deploy-derive-"));
  try {
    const keyPath = join(dir, "id_imported");
    // ssh-keygen refuses a group/world-readable key file, and the trailing
    // newline is part of the PEM framing it expects.
    await writeFile(keyPath, `${privateKey.trimEnd()}\n`, { mode: 0o600 });

    // `spawnCaptured`, not `spawnExpectOk`: a non-zero exit is a domain outcome
    // we classify below, and SpawnFailedError's message (argv + temp path) is
    // not copy we would ever show a user.
    //
    // `-P ""` makes ssh-keygen FAIL on an encrypted key instead of prompting.
    // Belt and braces: spawnCaptured gives the child `stdin: "ignore"` when no
    // stdin is passed, so even a prompt hits EOF — this call structurally
    // cannot hang the request.
    const result = await spawnCaptured(
      ["ssh-keygen", "-y", "-P", "", "-f", keyPath],
      {
        timeoutMs: SSH_KEYGEN_TIMEOUT_MS,
      },
    );
    if (result.exitCode !== 0) {
      throw classifyKeygenFailure(result.stderr);
    }

    // Rebuild the line from algorithm + blob rather than appending to what
    // ssh-keygen printed: depending on the OpenSSH version `-y` either drops
    // the private key's own comment or echoes it, and appending to the latter
    // yields a line with two comments. Ours has to be the only one — it is what
    // the install command's cleanup clause anchors on. Safe because the
    // fingerprint covers the blob alone, never the comment.
    const [algorithm, blob] = result.stdout.trim().split(/\s+/);
    if (algorithm === undefined || blob === undefined) {
      throw new InvalidSshKeyError(
        "unsupported-format",
        "ssh-keygen exited cleanly but produced no public key",
      );
    }
    return `${algorithm} ${blob} ${comment}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function looksLikePublicKey(text: string): boolean {
  try {
    parseSshPublicKey(text);
    return true;
  } catch (err) {
    if (err instanceof InvalidSshKeyError) return false;
    throw err;
  }
}

function classifyKeygenFailure(stderr: string): InvalidSshKeyError {
  if (/incorrect passphrase/i.test(stderr)) {
    return new InvalidSshKeyError("passphrase-protected", stderrTail(stderr));
  }
  if (/invalid format|error in libcrypto|not a key/i.test(stderr)) {
    return new InvalidSshKeyError("not-a-private-key", stderrTail(stderr));
  }
  return new InvalidSshKeyError("unsupported-format", stderrTail(stderr));
}
