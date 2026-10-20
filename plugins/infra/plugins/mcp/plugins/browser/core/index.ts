// Leaf by contract: no `node:*` and no Playwright — the e2e harness imports
// this barrel to read the tickets the server half issues.
export {
  attachMarker,
  encodeAttachTicket,
  decodeAttachTicket,
} from "./internal/attach-ticket";
export type { AttachTicket } from "./internal/attach-ticket";
export {
  agentBrowserStatus,
  agentBrowserUsage,
  AgentBrowserHostStatusSchema,
  AgentBrowserUsageSchema,
  AgentBrowserStatusSchema,
  MAX_HOST_ERRORS,
  MAX_SESSIONS,
  MAX_TABS,
} from "./internal/status";
export type {
  AgentBrowserHostError,
  AgentBrowserHostStatus,
  AgentBrowserSession,
  AgentBrowserStatus,
  AgentBrowserTab,
  AgentBrowserProcessRole,
  AgentBrowserUsage,
  AgentBrowserUsageGroup,
} from "./internal/status";
