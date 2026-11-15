import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { flushRoleEvents } from "../core";
import { supervisorEventsFlushJob } from "./internal/deliver";
import { handleFlushRoleEvents } from "./internal/routes";

export { publishSupervisorEvent } from "./internal/deliver";
export type { SupervisorEvent } from "./internal/deliver";

export default {
  description:
    "Supervisor event streams, desktop half: only the host's own backend (main, or a release's) gathers and delivers — a worktree's forked roles and sessions are main's; publishSupervisorEvent only gathers an event for the role its stream is routed to; the role's keyed supervisor-events.flush job sends ONE summarized message (×count kind · title per line, the most frequent 20 shown and the rest summed by kind in a `+N more` line) — the first after a quiet period at once, the rest when the quiet period ends — claimed under the role's lock, then delivered outside any transaction (if delivery throws, the message is kept as failed — its quiet period still holds — and its events put back): typed into its live session as an event turn, or with none dropped, filed as one backlog task, or briefed into a session it launches; POST /api/supervisor-roles/:id/events/flush sends now.",
  httpRoutes: { [flushRoleEvents.route]: handleFlushRoleEvents },
  register: [supervisorEventsFlushJob],
} satisfies MachinePluginDefinition;
