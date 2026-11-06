import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import { cloneNamedBinary } from "@plugins/packages/plugins/process-name/machine";
import { processName } from "@plugins/packages/plugins/process-name/core";

/** The gateway's own spawn convention when a spec has no `command`. */
const GATEWAY_DEFAULT_ENTRY = "bin/index.ts";

/**
 * The spec `command` that starts namespace `ns`'s backend as `bun <entry>`
 * (relative to the spec's `server` dir) through a clone of `bun` named for it
 * (`equin · server · <ns>`, `equin · central`), so Activity Monitor tells the
 * backends apart. When the clone cannot be made — no `bun` to name, or a
 * filesystem refusing it (said so on the build's output) — the default entry is
 * left to the gateway's own convention (`bun bin/index.ts`), and any other runs
 * under the bare `bun`.
 *
 * The clone pins the Bun this build resolved: a backend the gateway restarts
 * later runs the same one, until the next build re-clones it.
 */
export function namedBackendCommand(
  ns: string,
  bun: AppPath | null,
  entry: string,
): string[] | undefined {
  const unnamed = entry === GATEWAY_DEFAULT_ENTRY ? undefined : ["bun", entry];
  if (bun === null) return unnamed;
  const named = cloneNamedBinary({
    bin: bun,
    dir: worktreeArtifacts.processNames(asNamespace(ns)),
    name: ns === "central" ? processName("central") : processName("server", ns),
  });
  if (named.kind === "refused") {
    console.log(
      `  could not clone bun for ${ns} (${named.code}): its backend runs as a bare \`bun\``,
    );
    return unnamed;
  }
  return [named.path, entry];
}
