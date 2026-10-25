import type { SshKey } from "@plugins/apps/plugins/deploy/plugins/servers/web";

/**
 * A comment we are willing to interpolate into the `sed` address. The `sed`
 * argument is a REGEX, not a literal, so a comment carrying `/`, `.`, `*` or a
 * bracket would silently match — and delete — lines it was never meant to.
 * Our own comments are always `<prefix><serverId>` (the deploy key comment prefix), so this always
 * passes; the point is that the builder refuses rather than blind-interpolates.
 */
const SAFE_COMMENT = /^[A-Za-z0-9_.-]+$/;

/** POSIX single-quote a value: close, escape, reopen. Safe for any bytes. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The one-liner that installs this server's public key into `authorized_keys`.
 *
 * Emitted as a single line on purpose: it is copy-pasted into a provider web
 * terminal, where a backslash continuation is one stray trailing space away
 * from being a truncated command.
 *
 * Each clause earns its place:
 *
 * - **`restrict,pty`** kills port/agent/X11 forwarding — the real pivot
 *   boundary — while keeping interactive shells, which a deploy path needs. A
 *   PTY is not a privilege boundary when the key already grants root command
 *   execution. Drop `,pty` if a future deploy path never needs a tty. Note a
 *   pre-7.2 sshd (2016) rejects `restrict` and so rejects the whole line.
 * - **`sed -i.bak '/ <comment>$/d'`** makes the command self-cleaning: we own
 *   the comment and it is stable across regenerations, so re-running install
 *   after a replace removes the key this app installed last time. `-i.bak`
 *   works on GNU *and* BSD sed; the `$` anchor stops it deleting a line whose
 *   comment merely starts with ours. Omitted (degrading to non-cleaning, which
 *   is honest) when the comment fails `SAFE_COMMENT`.
 * - **`printf '\n%s\n'` rather than `echo`** — `echo …>>` splices onto the
 *   previous line when the file has no trailing newline, silently corrupting
 *   *both* entries. A leading newline is unconditionally safe (sshd ignores
 *   blank lines), and `printf` avoids `echo`'s shell-dependent backslash and
 *   leading-`-` handling.
 */
export function installCommand(key: SshKey): string {
  const line = `restrict,pty ${key.publicKey}`;
  const clean = SAFE_COMMENT.test(key.comment)
    ? ` && sed -i.bak ${quote(`/ ${key.comment}$/d`)} ~/.ssh/authorized_keys`
    : "";
  return (
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys" +
    clean +
    ` && printf '\\n%s\\n' ${quote(line)} >> ~/.ssh/authorized_keys` +
    " && chmod 600 ~/.ssh/authorized_keys"
  );
}
