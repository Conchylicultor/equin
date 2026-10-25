import { readyNow } from "@plugins/infra/plugins/deps/deps";
import { builtFile } from "@plugins/infra/plugins/deps/plugins/build/deps";
import {
  onDepInstallSettled,
  requestDep,
} from "@plugins/infra/plugins/deps/server";
import { spawnDisclaimWanted } from "@plugins/packages/plugins/spawn-disclaim/core";
import { disclaimExec } from "@plugins/packages/plugins/spawn-disclaim/deps";
import { recordReport } from "@plugins/reports/plugins/engine/server";

// The agent runs claude through `disclaim-exec` (packages/spawn-disclaim), so
// macOS attributes claude's permission prompts to claude rather than to the
// gateway launchd started. The helper is an on-demand build dependency:
// requested at boot, resolved at every agent start — never a reason for an
// agent not to start.

/** How long a launch waits for an install still running before going without. */
const INSTALL_WAIT_MS = 5_000;

/** At boot (off the event loop: the install is the `deps.install` job). */
export async function requestDisclaimHelper(): Promise<void> {
  if (!spawnDisclaimWanted()) return;
  if ((await readyNow(disclaimExec)).kind === "ready") return;
  await requestDep(disclaimExec);
}

/**
 * The helper's path for this agent start, or null when the disclaim is not
 * wanted here (not macOS, or `EQUIN_NO_SPAWN_DISCLAIM=1`) or the helper
 * is not installed within a short wait — reported, and the agent launches
 * without it (its prompts then name the gateway).
 */
export async function resolveDisclaimExec(
  conversationId: string,
): Promise<string | null> {
  if (!spawnDisclaimWanted()) return null;
  const now = await readyNow(disclaimExec);
  if (now.kind === "ready") return builtFile(now.ready);

  let off = (): void => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = new Promise<void>((resolve) => {
    off = onDepInstallSettled(disclaimExec, resolve);
    timer = setTimeout(resolve, INSTALL_WAIT_MS);
  });
  try {
    // Subscribed first, so a run that settles at once is not missed. A request
    // made while an install runs elsewhere waits on its lock and settles right
    // after it. A failed install is not retried by every launch (boot retries).
    if (now.kind !== "failed") {
      await requestDep(disclaimExec);
      await settled;
    }
  } finally {
    clearTimeout(timer);
    off();
  }

  const after = await readyNow(disclaimExec);
  if (after.kind === "ready") return builtFile(after.ready);
  await recordReport({
    kind: "crash",
    source: "server-caught",
    message: `SDK agent ${conversationId}: launched without disclaim-exec (${after.kind === "failed" ? `its install failed: ${after.message}` : `still ${after.kind} after ${String(INSTALL_WAIT_MS / 1000)} s`}), so its macOS permission prompts name the gateway instead of claude`,
    data: {
      errorType: "SdkAgentDisclaimUnavailable",
      label: "runtime-sdk.disclaim",
    },
  });
  return null;
}
