import { endpointPath } from "@plugins/infra/plugins/endpoints/core";
import { mcpRequest } from "@plugins/infra/plugins/mcp/core";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ScratchProfile,
  type WorkspaceImpl,
} from "@plugins/conversations/plugins/workspace/server";
import { GUARD_SCRIPTS } from "@plugins/framework/plugins/tooling/plugins/guards/plugins/agent-policy/core";
import { namespaceUrl } from "@plugins/infra/plugins/namespace/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { scratchWorkspacesDir } from "../../data-dirs";
import { assertDirTrusted } from "../../core";
import { scratchLaunchFragment } from "./launch-fragment";

// A plain directory, `<data>/state/workspaces/<attemptId>`, holding only what
// its profile provides: no git, no DB fork, no build, no repo context.
//
// `assertTrusted` is injected so a test can run `prepare` on a temp dir; the
// real one reads Claude Code's user config.
export function createScratchWorkspace(deps: {
  assertTrusted: (dir: string) => void;
  /** The checkout the agent's guards run from (see `scratchLaunchFragment`). */
  guardsRoot: () => string;
}): WorkspaceImpl<"scratch"> {
  return {
    kind: "scratch",

    async root() {
      return scratchWorkspacesDir.path;
    },

    // Nothing beside the attempt row: no DB fork.
    async onCommit() {},

    // The profile's instructions are the agent's whole project context, so they
    // are (re)written on every prepare — a profile improved since the last
    // launch applies to a retried spawn too. Then the profile's own prepare
    // (inputs, deps, `bin/` wrappers). Idempotent, as the spawn job requires.
    async prepare({ attemptId, path, spec }, signal) {
      // A session in an untrusted dir stops at Claude Code's trust dialog and
      // sits there, `starting`, with nothing reporting why — so refuse here,
      // loudly (the boot step `trustScratchRoot` trusts the scratch root).
      deps.assertTrusted(path);
      const profile = ScratchProfile.get(spec.profile);
      await mkdir(path, { recursive: true });
      await Bun.write(
        join(path, "CLAUDE.md"),
        profile.instructions(spec.input),
      );
      await profile.prepare?.({
        dir: path,
        attemptId,
        input: spec.input,
        signal,
      });
    },

    async onFinish() {},

    launch({ spec }, { conversationId }) {
      const profile = ScratchProfile.get(spec.profile);
      return scratchLaunchFragment({
        mcpUrl: namespaceUrl(
          runtimeNamespace(),
          endpointPath(mcpRequest, { conversationId }),
        ),
        guardsRoot: deps.guardsRoot(),
        permissions: profile.permissions,
        sandbox: profile.sandbox,
      });
    },

    // The dir is the only copy of the inputs the profile materialized, so a
    // reaped one cannot be rebuilt here — the message says why it is gone.
    checkResumable({ path }) {
      if (existsSync(path)) return { kind: "ok" };
      return {
        kind: "missing",
        message:
          `This conversation's scratch workspace is gone (${path}), so it cannot be resumed. ` +
          `Scratch workspaces are deleted a week after their task is done or dropped; ` +
          `start a new conversation from the task instead.`,
      };
    },
  };
}

/**
 * This backend's checkout, once its guard scripts are known to be there: a
 * launch must not install hooks that cannot run (a scratch agent has no other
 * guards).
 */
function launchingCheckoutGuards(): string {
  for (const rel of Object.values(GUARD_SCRIPTS)) {
    if (!existsSync(join(REPO_ROOT, rel))) {
      throw new Error(
        `scratch launch: guard script missing at ${join(REPO_ROOT, rel)} — refusing to launch an unguarded agent`,
      );
    }
  }
  return REPO_ROOT;
}

export const scratchWorkspace = createScratchWorkspace({
  assertTrusted: (dir) => assertDirTrusted(dir),
  guardsRoot: launchingCheckoutGuards,
});
