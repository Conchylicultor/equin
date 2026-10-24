/**
 * Pure parsers for the two places an OS records an account's full name. Kept
 * apart from the reader that spawns the commands so each format is tested on
 * its own.
 */

/**
 * The full name from macOS `id -F` output (the account's RealName), or `null`
 * when it prints nothing.
 */
export function parseIdFullName(stdout: string): string | null {
  const name = stdout.trim();
  return name === "" ? null : name;
}

/**
 * The full name from one passwd line (`name:pw:uid:gid:gecos:home:shell`, as
 * `getent passwd <user>` prints it), or `null` when its GECOS field holds none.
 *
 * GECOS is comma-separated — full name, room, work phone, home phone, other —
 * and only its first part is the name. A `&` in it stands for the login name
 * with its first letter capitalised (the BSD/`finger` convention).
 *
 * Throws on a line that is not a passwd entry: that is a broken read, not an
 * account without a name.
 */
export function parseGecosFullName(passwdLine: string): string | null {
  const fields = passwdLine.trim().split(":");
  if (fields.length < 7) {
    throw new Error(
      `host-account: not a passwd entry (expected 7 ':'-separated fields, got ${fields.length}): ${JSON.stringify(passwdLine)}`,
    );
  }
  const username = fields[0]!;
  const gecosName = fields[4]!.split(",")[0]!.trim();
  if (gecosName === "") return null;
  return gecosName.replaceAll(
    "&",
    username.charAt(0).toUpperCase() + username.slice(1),
  );
}
