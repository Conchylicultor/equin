import { linkSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { conversationDisplayTitle } from "../../server/internal/rows";
import { linkName } from "./link-name";
import { agentClaudeLinkDir } from "./paths";

// The claude an agent spawns, named for its conversation. Run through
// disclaim-exec, claude is its own responsible process, and macOS names a
// bundle-less executable by its FILE NAME in a permission prompt — which for
// the native installer is the version (`versions/2.1.308`), so every agent
// asked as "2.1.308". A hardlink is the same signed file under another name:
// the prompt reads "equin · conv-… · Fix login bug".
//
// TCC also keys a bundle-less client's decisions by that path (measured
// 2026-10-24: an Allow given to a renamed hardlink did not reach the original
// path, nor the reverse), so each conversation's grants are its own — the
// point: one Allow no longer covers every agent. The name is therefore chosen
// ONCE, at the conversation's first start, and kept across its relaunches
// (read back from the previous launch's options), so a grant lasts the whole
// conversation even when its title changes. Each start relinks it to the
// current binary, so a Claude update reaches it.
//
// The agent removes the link when it exits (`bin/agent.ts`): a link left in
// place would pin a binary Claude's updater has since deleted.

/**
 * The hardlink this start of `conversationId` spawns, or null to spawn
 * `claudeBin` itself — no disclaim (the prompt names the gateway, so a name
 * would show nowhere), or a filesystem refusing the link (reported).
 */
export async function namedClaudeBin(opts: {
  conversationId: string;
  claudeBin: string;
  disclaimExec: string | null;
  previous: string | null;
}): Promise<string | null> {
  const { conversationId: id } = opts;
  if (opts.disclaimExec === null) return null;
  const dir = agentClaudeLinkDir(id);
  const name = opts.previous
    ? basename(opts.previous)
    : linkName(await conversationDisplayTitle(id), id);
  const path = join(dir, name);
  const staging = join(dir, `.${process.pid}.tmp`);
  mkdirSync(dir, { recursive: true });
  rmSync(staging, { force: true });
  try {
    linkSync(realpathSync(opts.claudeBin), staging);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP") throw err;
    await recordReport({
      kind: "crash",
      source: "server-caught",
      message: `SDK agent ${id}: could not hardlink claude into ${dir} (${code}), so its macOS permission prompts name the claude binary's version instead of the conversation`,
      data: { errorType: "SdkAgentClaudeLink", label: "runtime-sdk.disclaim" },
    });
    return null;
  }
  // Swapped in whole: a relaunch never sees the name missing or half-made.
  renameSync(staging, path);
  return path;
}
