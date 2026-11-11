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
  /** Requests sent and not answered yet, on any port. */
  unanswered: number;
  /** Told when `unanswered` drops back to 0 (`armHostAnswers`). */
  onSettled: (() => void)[];
  /** The armed wait, once `armHostAnswers` set it. */
  armed?: Promise<void>;
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
    const log: HostRequestLog = {
      answered: [],
      unanswered: 0,
      onSettled: [],
    };
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
        log.unanswered += 1;
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
      log.unanswered -= 1;
      log.answered.push(req);
      if (log.unanswered === 0)
        for (const told of log.onSettled.splice(0)) told();
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

/**
 * How many requests the page's current document sent a browser host that it
 * has not answered yet (`recordHostRequests` must be on). Zero: the host has
 * every write the page made so far.
 */
export async function hostRequestsUnanswered(page: Page): Promise<number> {
  return page.evaluate(() => {
    const log = window.__equinHostRequests;
    if (log === undefined)
      throw new Error(
        "host requests are not recorded on this page: call recordHostRequests before it loads",
      );
    return log.unanswered;
  });
}

/**
 * Arm a wait, in the page, for the NEXT time every request sent to a browser
 * host from now on has been answered (`recordHostRequests` must be on); the
 * returned function waits for it. Arm before an action, act, then await it:
 * it resolves inside the page the instant the host's last answer arrives — no
 * polling between the answer and whatever the script does next (closing the
 * tab "at once").
 */
export async function armHostAnswers(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const log = window.__equinHostRequests;
    if (log === undefined)
      throw new Error(
        "host requests are not recorded on this page: call recordHostRequests before it loads",
      );
    const sentBefore = log.unanswered;
    if (sentBefore !== 0)
      throw new Error(
        `armHostAnswers: ${sentBefore} request(s) still unanswered — arm once the host has answered them`,
      );
    log.armed = new Promise<void>((resolve) => log.onSettled.push(resolve));
  });
  return () =>
    page.evaluate(async () => {
      await window.__equinHostRequests!.armed;
    });
}
