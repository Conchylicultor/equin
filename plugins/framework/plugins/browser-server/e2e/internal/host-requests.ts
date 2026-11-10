import type { Page } from "playwright";
import type { AnyEndpointDef } from "@plugins/infra/plugins/endpoints/core";
import { endpointPath } from "@plugins/infra/plugins/endpoints/e2e";

/**
 * What a page sent its browser hosts and what they answered, as the port
 * protocol carries it (`core/internal/port.ts`): a `{ t: "request", id,
 * request: { method, url } }` posted on a port, answered by a `{ t:
 * "response", id }` on the same port. Kept on the page's window, per document.
 */
interface HostRequestLog {
  answered: { method: string; pathname: string }[];
}

declare global {
  interface Window {
    __equinHostRequests?: HostRequestLog;
  }
}

/** The pages already recording. */
const recording = new WeakSet<Page>();

/**
 * Record, on every document `page` loads from now on (its reloads included),
 * each request the page sends a browser host over a port and whether the host
 * answered it — a write to the demo's worker is invisible to Playwright's
 * network events, and a write's card or toast can go away before the request
 * has even left the page (a fire-and-forget answer). Call it before the page
 * connects to the host (before `boot`): the response listener is wrapped as it
 * is added.
 */
export async function recordHostRequests(page: Page): Promise<void> {
  if (recording.has(page)) return;
  recording.add(page);
  await page.addInitScript(() => {
    const log: HostRequestLog = { answered: [] };
    window.__equinHostRequests = log;
    // Per port: the request ids the page posted, by id — ids are per requester.
    const sent = new WeakMap<
      MessagePort,
      Map<number, { method: string; pathname: string }>
    >();
    const sentOn = (port: MessagePort) => {
      let m = sent.get(port);
      if (m === undefined) {
        m = new Map();
        sent.set(port, m);
      }
      return m;
    };
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (
      this: MessagePort,
      message: unknown,
      ...rest: unknown[]
    ) {
      const m = message as {
        t?: unknown;
        id?: unknown;
        request?: { method?: unknown; url?: unknown };
      } | null;
      if (
        m?.t === "request" &&
        typeof m.id === "number" &&
        typeof m.request?.url === "string"
      ) {
        sentOn(this).set(m.id, {
          method: String(m.request.method),
          pathname: new URL(m.request.url).pathname,
        });
      }
      return (post as (...a: unknown[]) => void).call(this, message, ...rest);
    } as typeof MessagePort.prototype.postMessage;
    // One observer per port, added beside its first message listener (the
    // port requester's): a port delivers only once one is listening.
    const observed = new WeakSet<MessagePort>();
    const observe = (port: MessagePort) => (event: Event) => {
      const d = (event as MessageEvent).data as {
        t?: unknown;
        id?: unknown;
      } | null;
      if (d?.t !== "response" || typeof d.id !== "number") return;
      const req = sentOn(port).get(d.id);
      if (req === undefined) return;
      sentOn(port).delete(d.id);
      log.answered.push(req);
    };
    const add = MessagePort.prototype.addEventListener;
    MessagePort.prototype.addEventListener = function (
      this: MessagePort,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === "message" && !observed.has(this)) {
        observed.add(this);
        add.call(this, "message", observe(this));
      }
      add.call(this, type, listener, options);
    } as typeof MessagePort.prototype.addEventListener;
  });
}

/**
 * How many requests to `endpoint` (at `params`) a browser host has answered
 * on the page's current document (`recordHostRequests` must be on). Read it
 * before an action, then wait for it to grow: the host has the write.
 */
export async function hostRequestsAnswered<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  page: Page,
  endpoint: AnyEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  params: TParams,
): Promise<number> {
  const method = endpoint.method;
  const pathname = endpointPath(endpoint, params);
  return page.evaluate(
    ([method, pathname]) => {
      const log = window.__equinHostRequests;
      if (log === undefined)
        throw new Error(
          "host requests are not recorded on this page: call recordHostRequests before it loads",
        );
      return log.answered.filter(
        (r) => r.method === method && r.pathname === pathname,
      ).length;
    },
    [method, pathname] as const,
  );
}
