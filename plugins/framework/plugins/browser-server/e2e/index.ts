/**
 * e2e barrel for browser servers: what a page asked its browser hosts and what
 * they answered (requests cross a port, so Playwright's network events never
 * see them), importable as `@plugins/framework/plugins/browser-server/e2e`.
 */
export {
  armHostAnswers,
  recordHostRequests,
  hostRequestsAnswered,
  hostRequestsUnanswered,
} from "./internal/host-requests";
