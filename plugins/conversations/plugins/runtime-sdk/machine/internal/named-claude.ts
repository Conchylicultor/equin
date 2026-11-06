import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { basename } from "node:path";
import { cloneNamedBinary } from "@plugins/packages/plugins/process-name/machine";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { conversationDisplayTitle } from "../../server/internal/rows";
import { linkName } from "./link-name";
import { agentBinDir } from "./paths";

// The claude an agent spawns, named for its conversation. Run through
// disclaim-exec, claude is its own responsible process, and macOS names a
// bundle-less executable by its FILE NAME in a permission prompt — which for
// the Agent SDK's bundled build is a bare `claude` (for the native installer
// it was the version, `versions/2.1.308`), so every agent asked alike. A clone is the same signed bytes under another name:
// the prompt reads "equin · conv-… · Fix login bug".
//
// TCC also keys a bundle-less client's decisions by that path (measured
// 2026-10-24: an Allow given to a renamed hardlink did not reach the original
// path, nor the reverse), so each conversation's grants are its own — the
// point: one Allow no longer covers every agent. The name is therefore chosen
// ONCE, at the conversation's first start, and kept across its relaunches
// (read back from the previous launch's options), so a grant lasts the whole
// conversation even when its title changes. Each start re-clones it from
// the current binary when that changed, so an SDK upgrade reaches it.
//
// The agent removes the clone when it exits (`bin/agent.ts`): a clone left in
// place would pin a binary a reinstall has since replaced.

/**
 * The named clone this start of `conversationId` spawns, or null to spawn
 * `claudeBin` itself — no disclaim (the prompt names the gateway, so a name
 * would show nowhere), or a filesystem refusing the clone (reported).
 */
export async function namedClaudeBin(opts: {
  conversationId: string;
  claudeBin: AppPath;
  disclaimExec: string | null;
  previous: string | null;
}): Promise<string | null> {
  const { conversationId: id } = opts;
  if (opts.disclaimExec === null) return null;
  const dir = agentBinDir(id);
  const name = opts.previous
    ? basename(opts.previous)
    : linkName(await conversationDisplayTitle(id), id);
  const named = await cloneNamedBinary({ bin: opts.claudeBin, dir, name });
  if (named.kind === "cloned") return named.path;
  await recordReport({
    kind: "crash",
    source: "server-caught",
    message: `SDK agent ${id}: could not clone claude into ${dir} (${named.code}), so its macOS permission prompts name the claude binary's version instead of the conversation`,
    data: { errorType: "SdkAgentClaudeLink", label: "runtime-sdk.disclaim" },
  });
  return null;
}
