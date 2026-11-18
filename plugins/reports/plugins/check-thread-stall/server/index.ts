import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { checkPassHungKind, checkThreadStallKind } from "./internal/kind";

export default {
  description:
    "Check-thread-stall report kind: validates the check runner's thread-stall payloads (trigger stall = one stall whose code held the thread ≥ 2 s — held, not merely late: a starved thread files nothing —, fingerprinted by its top owner; trigger total = a run whose stalls add up to ≥ 20 s held, one row), filed through the report outbox, and renders a task naming the owner, its stacks, the held-vs-starved split and the run's transcript. Warning, re-arms every 6 h. Also the check-pass-hung kind: a pass whose main thread held its core 5 min without yielding, killed by its own watchdog thread — one row, an error, its task naming the checks in flight and the main thread's native stack.",
  contributions: [checkThreadStallKind, checkPassHungKind],
} satisfies ServerPluginDefinition;
