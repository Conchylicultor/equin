import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import {
  cloneNamedBinary,
  processName,
} from "@plugins/packages/plugins/process-name/machine";

/**
 * The spec `command` that starts namespace `ns`'s backend as `bun bin/index.ts`
 * — the gateway's own convention — through a clone of `bun` named for it
 * (`equin · server · <ns>`, `equin · central`), so Activity Monitor tells the
 * backends apart. Undefined leaves the convention to the gateway: no `bun` to
 * name, or a filesystem refusing the clone (said so on the build's output).
 *
 * The clone pins the Bun this build resolved: a backend the gateway restarts
 * later runs the same one, until the next build re-clones it.
 */
export function namedBackendCommand(
  ns: string,
  bun: AppPath | null,
): string[] | undefined {
  if (bun === null) return undefined;
  const named = cloneNamedBinary({
    bin: bun,
    dir: worktreeArtifacts.processNames(asNamespace(ns)),
    name: ns === "central" ? processName("central") : processName("server", ns),
  });
  if (named.kind === "refused") {
    console.log(
      `  could not clone bun for ${ns} (${named.code}): its backend runs as a bare \`bun\``,
    );
    return undefined;
  }
  return [named.path, "bin/index.ts"];
}
