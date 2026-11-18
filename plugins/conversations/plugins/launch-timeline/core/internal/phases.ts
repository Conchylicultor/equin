/**
 * The instants of one agent launch, in the order they normally happen, after
 * the request itself (the conversation row's creation — the record's
 * `requestedAt`, offset 0). A closed list: every writer names one, and the
 * stats derive their rows from it.
 *
 * Each mark is a wall-clock epoch ms written by the process that saw it — the
 * backend, the checkout child, the agent — all on one machine, so their clocks
 * compare (one instance per user).
 */
export const LAUNCH_PHASES = [
  {
    id: "spawn-started",
    label: "Spawn job started",
    by: "The conversations.spawn job's body, its first run (a retry keeps the first instant).",
  },
  {
    id: "prepare-child-started",
    label: "Checkout child started",
    by: "The worktree.prepare child process began (its process start), before it waits for a worktree-prepare slot and boots.",
  },
  {
    id: "prepare-booted",
    label: "Checkout child booted",
    by: "The child holds its slot and booted its plugin graph: its run body starts.",
  },
  {
    id: "prepare-ended",
    label: "Checkout ready",
    by: "The child's checkout and install finished (setupWorktree returned).",
  },
  {
    id: "agent-started",
    label: "Agent process started",
    by: "The agent process wrote `started` (its socket listens).",
  },
  {
    id: "cli-ready",
    label: "Claude CLI ready",
    by: "Claude Code answered its initialize (`ready`).",
  },
  {
    id: "first-token",
    label: "First streamed token",
    by: "The first streamed frame of the model's first reply.",
  },
  {
    id: "first-message",
    label: "First complete message",
    by: "The first complete top-level assistant message.",
  },
] as const;

export type LaunchPhase = (typeof LAUNCH_PHASES)[number]["id"];

export const LAUNCH_PHASE_IDS = LAUNCH_PHASES.map((p) => p.id) as [
  LaunchPhase,
  ...LaunchPhase[],
];

/** The phases the agent process itself reports, through its events file. */
export const AGENT_LAUNCH_PHASES = [
  "agent-started",
  "cli-ready",
  "first-token",
  "first-message",
] as const satisfies readonly LaunchPhase[];
export type AgentLaunchPhase = (typeof AGENT_LAUNCH_PHASES)[number];

/** The start of the record: the request (`requestedAt`), or a phase. */
export type LaunchInstant = "requested" | LaunchPhase;

/**
 * A stretch of a launch, between two instants. Stats are taken per segment
 * (the end minus the start, on launches that have both), so a segment stays
 * measurable if a change reorders the phases — e.g. the agent starting while
 * the checkout still installs, where `prepare-ended → agent-started` goes
 * negative and `requested → agent-started` is the number that moved.
 */
export interface LaunchSegment {
  id: string;
  label: string;
  from: LaunchInstant;
  to: LaunchPhase;
  /** A sum of the segments above it, shown apart. */
  total?: true;
}

export const LAUNCH_SEGMENTS: readonly LaunchSegment[] = [
  {
    id: "queue",
    label: "Request → spawn job runs",
    from: "requested",
    to: "spawn-started",
  },
  {
    id: "child-start",
    label: "Spawn → checkout child started",
    from: "spawn-started",
    to: "prepare-child-started",
  },
  {
    id: "child-boot",
    label: "Child: slot wait + boot",
    from: "prepare-child-started",
    to: "prepare-booted",
  },
  {
    id: "checkout",
    label: "Child: checkout + install",
    from: "prepare-booted",
    to: "prepare-ended",
  },
  {
    id: "hand-off",
    label: "Checkout ready → agent started",
    from: "prepare-ended",
    to: "agent-started",
  },
  {
    id: "cli-init",
    label: "Claude CLI initialize",
    from: "agent-started",
    to: "cli-ready",
  },
  {
    id: "first-token",
    label: "CLI ready → first token",
    from: "cli-ready",
    to: "first-token",
  },
  {
    id: "first-message",
    label: "First token → first message",
    from: "first-token",
    to: "first-message",
  },
  {
    id: "to-agent",
    label: "Request → agent started",
    from: "requested",
    to: "agent-started",
    total: true,
  },
  {
    id: "to-first-token",
    label: "Request → first token",
    from: "requested",
    to: "first-token",
    total: true,
  },
  {
    id: "to-first-message",
    label: "Request → first message",
    from: "requested",
    to: "first-message",
    total: true,
  },
];
