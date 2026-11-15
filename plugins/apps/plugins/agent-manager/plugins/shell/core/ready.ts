/**
 * The attribute the Agent Manager's layout stamps on its shell once it has
 * rendered — what a script waits on to know the Agent Manager is showing,
 * whatever its sidebar happens to list (a label-based marker broke every demo
 * e2e script the day the sidebar's "Conversations" entry became "Queue").
 */
export const AGENT_MANAGER_READY_ATTR = "data-agent-manager-ready";

/** Matches the Agent Manager's shell once its layout has rendered. */
export const AGENT_MANAGER_READY = `[${AGENT_MANAGER_READY_ATTR}]`;
