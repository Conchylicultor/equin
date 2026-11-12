import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useReconnectingWebSocket } from "./use-reconnecting-ws";
export type {
  ReconnectingWsOptions,
  ReconnectingWsHandle,
  ReconnectingWsData,
} from "./use-reconnecting-ws";
export { SharedWebSocket } from "./shared-websocket";
export type {
  SharedWebSocketHooks,
  SharedWebSocketOptions,
  PageLifecycleLike,
  SocketMessage,
} from "./shared-websocket";
export type {
  LockManagerLike,
  MakeSharedWorker,
  MessagePortLike,
  SharedWorkerLike,
} from "./transport-types";
export { TransportProvider, useTransport } from "./transport";
export type { ContentServing, Transport, TransportSocket } from "./transport";
export { transportScoped, useTransportScoped } from "./transport-scoped";
export type { TransportScoped } from "./transport-scoped";
export { requestTimingOf, RESOURCE_TIMING_WAIT_MS } from "./request-timing";
export type { RequestTiming } from "./request-timing";
export { fetchWithRetry } from "./fetch-with-retry";
export type { FetchWithRetryOptions } from "./fetch-with-retry";
export { probeUrlStatus, type UrlStatus } from "./probe-url-status";
export { publishWsStatus, subscribeWsStatus } from "./ws-status-bus";
export type { WsStatus, WsStatusEvent } from "./ws-status-bus";
export { publishNetDiag, subscribeNetDiag } from "./net-diag-bus";
export type { NetDiagEvent } from "./net-diag-bus";
export { firedLate } from "./late-fire";

export default {
  description:
    "WebSocket / fetch primitives with reconnection, status-bus, and retry. Used by live-state internally and by terminal/logs/health/stats directly.",
  loadBearing: true,
  contributions: [],
} satisfies PluginDefinition;
