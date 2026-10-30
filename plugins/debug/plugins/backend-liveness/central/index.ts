import type { CentralPluginDefinition } from "@plugins/framework/plugins/central-core/core";
import { livenessProbeTimer } from "./internal/probe";

export default {
  description:
    "Backend liveness probe (central): every 15 s asks each running backend for any HTTP answer on its own socket, and appends a frozen episode to the backend-liveness data dir when one stays unanswered for a minute of awake time (machine sleep never counts; a stopped process is paused, not frozen) — from outside the backend, so a frozen JS thread is noticed while it lasts.",
  register: [livenessProbeTimer],
  onReady: () => livenessProbeTimer.start(),
  onShutdown: () => livenessProbeTimer.stop(),
} satisfies CentralPluginDefinition;
