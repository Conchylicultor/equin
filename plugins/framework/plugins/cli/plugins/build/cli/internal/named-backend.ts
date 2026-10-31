import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import {
  linkNamedBinary,
  processName,
} from "@plugins/packages/plugins/process-name/machine";

/**
 * The spec `command` that starts namespace `ns`'s backend as `bun bin/index.ts`
 * — the gateway's own convention — through a hardlink of `bun` named for it
 * (`equin · server · <ns>`, `equin · central`), so Activity Monitor tells the
 * backends apart. Undefined leaves the convention to the gateway: no `bun` to
 * name, or a filesystem refusing the link (said so on the build's output).
 *
 * The link pins the Bun this build resolved: a backend the gateway restarts
 * later runs the same one, until the next build relinks it.
 */
export function namedBackendCommand(
  ns: string,
  bun: string | null,
): string[] | undefined {
  if (bun === null) return undefined;
  const linked = linkNamedBinary({
    bin: bun,
    dir: worktreeArtifacts.processNames(asNamespace(ns)),
    name: ns === "central" ? processName("central") : processName("server", ns),
  });
  if (linked.kind === "refused") {
    console.log(
      `  could not hardlink bun for ${ns} (${linked.code}): its backend runs as a bare \`bun\``,
    );
    return undefined;
  }
  return [linked.path, "bin/index.ts"];
}
