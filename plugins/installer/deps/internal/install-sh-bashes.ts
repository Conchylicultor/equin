import { ensureDepViaCli } from "@plugins/infra/plugins/deps/deps";
import { downloadedFile } from "@plugins/infra/plugins/deps/plugins/download/deps";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import {
  bashBinaryName,
  installerTestBashes,
  PINNED_BASHES,
} from "./test-bashes";

/** One bash to run install.sh under, and what it is (a test title names it). */
export interface InstallShBash {
  readonly path: string;
  readonly label: string;
}

/**
 * Every bash install.sh's tests must pass under, wherever they run: GNU bash
 * 3.2 and 5.2 built from pinned source (the `installer-test-bashes`
 * dependency, installed on first use), plus `/bin/bash` — the shell
 * `curl … | bash` actually runs here (Apple's patched 3.2 on a Mac, the
 * distribution's 5.x on Linux). Never skips one: a dependency that cannot be
 * installed, or a binary that is not the version it is pinned to, throws.
 */
export async function installShBashes(): Promise<InstallShBash[]> {
  // grant null: a test runs inside `./equin test`, whose grant its env
  // carries (HOST_GRANT), so the install child spends it rather than queue.
  const ready = await ensureDepViaCli(installerTestBashes, {
    stdio: "capture",
    grant: null,
  });
  const pinned: InstallShBash[] = [];
  for (const b of PINNED_BASHES) {
    const path = downloadedFile(ready, bashBinaryName(b.version));
    const reported = await bashVersion(path);
    if (reported !== b.version)
      throw new Error(
        `${path} reports bash ${reported}, but it is pinned to ${b.version}`,
      );
    pinned.push({ path, label: `GNU bash ${b.version}` });
  }
  // A missing one fails the spawn, loudly.
  const system = "/bin/bash";
  return [
    ...pinned,
    { path: system, label: `${system} (${await bashVersion(system)})` },
  ];
}

/**
 * `x.y.z` of a bash binary, read from the binary itself: `$BASH_VERSION` is
 * `<x.y.z>(<build>)-<status>`.
 */
async function bashVersion(bash: string): Promise<string> {
  const res = await spawnExpectOk([bash, "-c", 'echo "$BASH_VERSION"'], {
    timeoutMs: 10_000,
  });
  const version = /^\d+\.\d+\.\d+/.exec(res.stdout.trim())?.[0];
  if (version === undefined)
    throw new Error(`${bash}: unexpected $BASH_VERSION ${res.stdout.trim()}`);
  return version;
}
