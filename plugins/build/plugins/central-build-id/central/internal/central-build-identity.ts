import { pathToFileURL } from "node:url";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { realpath } from "@plugins/packages/plugins/timed-fs/core";
import {
  setCentralBuildIdentity,
  type Registration,
} from "@plugins/framework/plugins/central-core/core";
import { sourceDigest } from "@plugins/packages/plugins/source-digest/central";
import { CENTRAL_ENTRY } from "../../core";
import { centralCodeSet } from "../../shared/central-code-set";

/**
 * Central's code build — what shapes every value central serves — named on its
 * ack frames and read envelopes as `graph` (`setCentralBuildIdentity`), so a tab
 * whose schema rejects a central value judges it against the build its own
 * bundle carries for central: another build is skew (out of date), the same
 * build a real bug.
 *
 * The digest of the entry THIS process runs (`Bun.main`, as restart-skip
 * reads it), read once at register — as close to the imports as boot allows,
 * and never again: a file edited later is another process's code. Central
 * adopts a deploy without restarting only when nothing its closure loads
 * changed (`build/restart-skip`), so the digest stays true across adoptions.
 *
 * Not awaited: a closure walk takes seconds and central serves every worktree's
 * auth. Until it lands — and if it cannot be computed — central names no build,
 * which a tab judges `unknown`: a decode failure stays a loud crash, never a
 * quiet "reload".
 */
export const centralBuildIdentityRegistration: Registration = {
  register() {
    void runTracked("central-build-id:digest", () =>
      pinCentralBuildIdentity().then(
        (digest) => {
          setCentralBuildIdentity(() => digest);
        },
        (err: unknown) => {
          console.error(
            "[central-build-id] central's code build is unknown — every central decode failure is judged `unknown` (a loud crash in the tab):",
            err,
          );
        },
      ),
    );
  },
};

async function pinCentralBuildIdentity(): Promise<string> {
  const entry = await realpath(Bun.main);
  // The build digests `CENTRAL_ENTRY` for the tab; a central started from any
  // other entry would be compared against a digest of different code.
  if (!entry.endsWith(`/${CENTRAL_ENTRY}`)) {
    throw new Error(
      `central runs ${entry}, not ${CENTRAL_ENTRY}: the build's digest would not name this process's code`,
    );
  }
  return sourceDigest([centralCodeSet(pathToFileURL(entry).href)]);
}
