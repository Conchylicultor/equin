import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useReconnectingWebSocket } from "./use-reconnecting-ws";
export type {
  ReconnectingWsOptions,
  ReconnectingWsHandle,
} from "./use-reconnecting-ws";
export { ReconnectingEventSource } from "./reconnecting-event-source";
export type { ReconnectingEventSourceOptions } from "./reconnecting-event-source";
export { SharedWebSocket } from "./shared-websocket";
export type {
  SharedWebSocketHooks,
  SharedWebSocketOptions,
  PageLifecycleLike,
} from "./shared-websocket";
export type {
  LockManagerLike,
  MakeSharedWorker,
  MessagePortLike,
  SharedWorkerLike,
} from "./transport-types";
export { TransportProvider, useTransport } from "./transport";
export type { Transport, TransportSocket } from "./transport";
export { transportScoped, useTransportScoped } from "./transport-scoped";
export type { TransportScoped } from "./transport-scoped";
export { fetchWithRetry } from "./fetch-with-retry";
export type { FetchWithRetryOptions } from "./fetch-with-retry";
export { probeUrlStatus, type UrlStatus } from "./probe-url-status";
export { publishWsStatus, subscribeWsStatus } from "./ws-status-bus";
export type { WsStatus, WsStatusEvent } from "./ws-status-bus";
export { publishNetDiag, subscribeNetDiag } from "./net-diag-bus";
export type { NetDiagEvent } from "./net-diag-bus";

export default {
  description:
    "WebSocket / EventSource / fetch primitives with reconnection, status-bus, and retry. Used by live-state internally and by terminal/logs/health/stats directly.",
  loadBearing: true,
  contributions: [],
} satisfies PluginDefinition;
