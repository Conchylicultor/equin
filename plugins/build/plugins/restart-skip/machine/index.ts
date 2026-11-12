import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { adoptDeploy } from "../core";
import { handleAdopt } from "./internal/handle-adopt";

export default {
  description:
    "Restart-skip, the backend half: POST /api/build/restart-skip/adopt — a deploy asks the running backend before restarting it, and the backend answers adopted only when a process spawned now would run exactly its code: the same Bun and entry, and nothing it loaded or could still load (every module in its loader, the entry's closure on disk with literal dynamic imports followed, package resolution entries, tsconfig/bunfig/package.json, every RestartSkip.BootInput) changed since it started, by inode change time. On adopted it runs every RestartSkip.Adopted hook (re-pin commit, web graph). Anything else is restart, with the reason. No boot work: the walk reads each file's facts from source-digest's host-wide store (the build's own closure checks recorded them), so a deploy's question reads only the files no process has read since they changed.",
  httpRoutes: {
    [adoptDeploy.route]: handleAdopt,
  },
} satisfies MachinePluginDefinition;
