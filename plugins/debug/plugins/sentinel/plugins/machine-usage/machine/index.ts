import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { machineUsageServed } from "./internal/sample";
import {
  forkMemoryDaemon,
  stopForkMemoryWorker,
} from "./internal/fork-memory/host";
import {
  ownerSamplerTimer,
  startOwnerSampler,
  stopOwnerSampler,
} from "./internal/owner-sampler";

export default {
  description:
    "Where the machine's CPU and memory go: the sentinel.machine-usage value — one ps over every process, attributed to the user's Chrome, the agents' ops (each running op marker's process tree), the agent browser (its host's process tree), the agents (each SDK agent's tree), the backends (the gateway, central, every worktree backend), Postgres or other, memory as each process's physical footprint, but Postgres's as each process's private memory with the cluster's shared segment counted once (a region walk on the machine-usage.fork-memory worker thread) — sampled on subscribe, served on every backend; and, on main, the same attribution persisted every 30 s to the health-owners log (CPU as each process's CPU-time delta, plus the largest processes) for Debug → Health.",
  contributions: [...machineUsageServed.declare],
  register: [ownerSamplerTimer, forkMemoryDaemon],
  onReady: () => {
    if (isMain()) startOwnerSampler();
  },
  onShutdown: async () => {
    if (isMain()) stopOwnerSampler();
    await stopForkMemoryWorker();
  },
} satisfies MachinePluginDefinition;
