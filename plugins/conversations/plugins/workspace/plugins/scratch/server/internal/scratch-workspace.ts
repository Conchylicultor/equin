import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ScratchProfile,
  type WorkspaceImpl,
} from "@plugins/conversations/plugins/workspace/server";
import { namespaceUrl } from "@plugins/infra/plugins/namespace/core";
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
      return scratchLaunchFragment({
        // eslint-disable-next-line endpoints/no-raw-endpoint-call -- handed to the Claude CLI as its MCP server URL, never fetched here
        mcpUrl: namespaceUrl(runtimeNamespace(), `/api/mcp/${conversationId}`),
        permissions: ScratchProfile.get(spec.profile).permissions,
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

export const scratchWorkspace = createScratchWorkspace({
  assertTrusted: (dir) => assertDirTrusted(dir),
});
