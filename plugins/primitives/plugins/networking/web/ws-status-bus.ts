import { markedListeners } from "./marked-listeners";

export type WsStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface WsStatusEvent {
  url: string;
  status: WsStatus;
}

const bus = markedListeners<WsStatusEvent>("ws-status", (ev) => ev.status);

/** Every subscriber's reaction is a marked task naming it (`name`, else the function's name). */
export function publishWsStatus(ev: WsStatusEvent): void {
  bus.publish(ev);
}

export function subscribeWsStatus(
  fn: (ev: WsStatusEvent) => void,
  name?: string,
): () => void {
  return bus.subscribe(fn, name);
}
