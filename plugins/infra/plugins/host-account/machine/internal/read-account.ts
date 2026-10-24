import { userInfo } from "node:os";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type { HostAccount } from "../../core";
import { parseGecosFullName, parseIdFullName } from "./parse";

/** `id -F` and `getent` answer from a local database; this is a ceiling. */
const READ_TIMEOUT_MS = 5_000;

/** `getent`'s exit status for "no such key" — an account the database does not list. */
const GETENT_NOT_FOUND = 2;

async function run(argv: string[]) {
  const r = await spawnCaptured(argv, {
    cwd: "/",
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (r.timedOut) {
    throw new Error(
      `host-account: \`${argv.join(" ")}\` did not answer within ${READ_TIMEOUT_MS / 1000}s`,
    );
  }
  return r;
}

/**
 * The account's full name as the OS records it, or `null` when it has none:
 * macOS `id -F` (the RealName), the passwd GECOS field (`getent passwd`)
 * elsewhere. Any other failure of the command throws — a broken read is not an
 * account without a name.
 */
async function readFullName(username: string): Promise<string | null> {
  if (process.platform === "darwin") {
    const r = await run(["id", "-F", username]);
    if (r.exitCode !== 0) {
      throw new Error(
        `host-account: \`id -F ${username}\` exited ${r.exitCode}: ${r.stderr.trim()}`,
      );
    }
    return parseIdFullName(r.stdout);
  }
  const r = await run(["getent", "passwd", username]);
  if (r.exitCode === GETENT_NOT_FOUND) return null;
  if (r.exitCode !== 0) {
    throw new Error(
      `host-account: \`getent passwd ${username}\` exited ${r.exitCode}: ${r.stderr.trim()}`,
    );
  }
  return parseGecosFullName(r.stdout);
}

/** Read the OS account this process runs as, now. */
export async function readHostAccount(): Promise<HostAccount> {
  const { username } = userInfo();
  return { username, fullName: await readFullName(username) };
}
