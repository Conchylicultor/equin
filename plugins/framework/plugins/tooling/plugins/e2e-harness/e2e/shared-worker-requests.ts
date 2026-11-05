/**
 * See the requests a SharedWorker makes — which no Playwright event does.
 *
 * Playwright attaches to a page's dedicated workers (their requests are the
 * page's `request` events) and to service workers, but never to a
 * SharedWorker target: a fetch a SharedWorker issues reaches no `page.on`,
 * `context.on` or `route`. The browser demo's host is one (one per build,
 * shared by every tab), so a script counting `page.on("request")` sees none
 * of its traffic and reads "no request" as "nothing was fetched".
 *
 * This taps the browser's own CDP: it discovers every `shared_worker` target,
 * attaches to each (non-flat sessions, so Playwright's own sessions are left
 * alone), enables the Network domain there and records each request and how
 * it was answered (a redirect is one entry per hop). A worker's requests
 * issued before its Network domain is on are not seen — tap before the page
 * that starts the worker loads, wait until `workers()` says the one you assert
 * on is `recording`, then drive what makes it fetch.
 *
 * An attached session keeps its worker alive after the last page leaves it,
 * and a page that comes back then talks to a held worker: the demo's host
 * never boots against it, the live socket's reads fall back to HTTP. A script
 * that needs the workers to end (a returning visitor) `release`s them before
 * leaving: the tap detaches, still sees each end (`running()`), and attaches
 * to the next ones.
 *
 * ```ts
 * const worker = await tapSharedWorkerRequests(h.browser);
 * await boot(page, pathUrl("/demo"));
 * await waitFor(() => worker.workers(), (ws) => ws.some((w) => w.recording));
 * // … drive the page …
 * const cdn = worker.requests.filter((r) => new URL(r.url).host === CDN);
 * ```
 */
import type { Browser, CDPSession } from "playwright";

export interface SharedWorkerRequest {
  /** The SharedWorker's script URL. */
  worker: string;
  method: string;
  url: string;
  /** The response status; absent while unanswered (or failed: see `failed`). */
  status?: number;
  /** Answered from the browser's HTTP cache, never reaching the network. */
  fromCache?: boolean;
  /** The network error text, when the request got no response. */
  failed?: string;
}

export interface SharedWorkerTap {
  /** Every request seen so far, in issue order (each entry updated as it is answered). */
  readonly requests: readonly SharedWorkerRequest[];
  /** The SharedWorkers still running (released ones included). */
  workers(): readonly SharedWorkerState[];
  /**
   * Detach from every running worker (of this script URL, when given), so
   * each can end once no page holds it; their requests from now on are not
   * recorded. A worker started later is attached as usual.
   */
  release(workerUrl?: string): Promise<void>;
  /** Detach from every worker and stop recording. */
  stop(): Promise<void>;
}

export interface SharedWorkerState {
  /** The worker's script URL. */
  url: string;
  /** Its requests are being recorded: attached, Network domain on, not released. */
  recording: boolean;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

/** One CDP message from an attached worker's session. */
interface WorkerMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  error?: { message: string };
}

interface RunningWorker {
  url: string;
  /** The tap's session on it; absent before the attach and once released. */
  sessionId?: string;
  /** Its Network.enable was answered. */
  enabled: boolean;
}

export async function tapSharedWorkerRequests(
  browser: Browser,
): Promise<SharedWorkerTap> {
  const cdp: CDPSession = await browser.newBrowserCDPSession();
  const requests: SharedWorkerRequest[] = [];
  /** `<sessionId>:<requestId>` → entry (request ids are per target). */
  const pending = new Map<string, SharedWorkerRequest>();
  /** sessionId → the worker, for the sessions still attached. */
  const sessions = new Map<string, RunningWorker>();
  /** targetId → the worker, while it runs. */
  const running = new Map<string, RunningWorker>();
  /** The id of each worker session's Network.enable call. */
  const enableCalls = new Map<string, number>();
  let nextId = 1;

  cdp.on(
    "Target.targetCreated",
    ({ targetInfo }: { targetInfo: TargetInfo }) => {
      if (targetInfo.type !== "shared_worker") return;
      const worker: RunningWorker = { url: targetInfo.url, enabled: false };
      running.set(targetInfo.targetId, worker);
      const attach = async (): Promise<void> => {
        const { sessionId } = await cdp.send("Target.attachToTarget", {
          targetId: targetInfo.targetId,
          flatten: false,
        });
        worker.sessionId = sessionId;
        sessions.set(sessionId, worker);
        const id = nextId++;
        enableCalls.set(sessionId, id);
        await cdp.send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id, method: "Network.enable" }),
        });
      };
      void attach().catch((err: unknown) => {
        // A worker that ended before the tap reached it has nothing to record.
        if (!running.has(targetInfo.targetId)) return;
        throw err;
      });
    },
  );

  cdp.on("Target.targetDestroyed", ({ targetId }: { targetId: string }) => {
    const worker = running.get(targetId);
    if (worker?.sessionId !== undefined) sessions.delete(worker.sessionId);
    running.delete(targetId);
  });

  cdp.on(
    "Target.receivedMessageFromTarget",
    ({ sessionId, message }: { sessionId: string; message: string }) => {
      const worker = sessions.get(sessionId);
      if (worker === undefined) return;
      const msg = JSON.parse(message) as WorkerMessage;
      if (msg.error !== undefined)
        throw new Error(
          `SharedWorker tap (${worker.url}): CDP call ${msg.id ?? "?"} failed: ${msg.error.message}`,
        );
      if (msg.id !== undefined && msg.id === enableCalls.get(sessionId))
        worker.enabled = true;
      const p = msg.params ?? {};
      const key = `${sessionId}:${String(p.requestId)}`;
      switch (msg.method) {
        case "Network.requestWillBeSent": {
          // A redirect re-sends the same request id: answer the previous hop.
          const redirect = p.redirectResponse as { status: number } | undefined;
          const hop = pending.get(key);
          if (redirect !== undefined && hop !== undefined)
            hop.status = redirect.status;
          const request = p.request as { url: string; method: string };
          const entry: SharedWorkerRequest = {
            worker: worker.url,
            method: request.method,
            url: request.url,
          };
          requests.push(entry);
          pending.set(key, entry);
          return;
        }
        case "Network.responseReceived": {
          const entry = pending.get(key);
          if (entry === undefined) return;
          const response = p.response as {
            status: number;
            fromDiskCache?: boolean;
            fromPrefetchCache?: boolean;
          };
          entry.status = response.status;
          entry.fromCache =
            response.fromDiskCache === true ||
            response.fromPrefetchCache === true;
          return;
        }
        case "Network.loadingFailed": {
          const entry = pending.get(key);
          if (entry !== undefined) entry.failed = String(p.errorText);
          return;
        }
        case undefined: // an answer to one of the tap's own calls
          return;
        default: // the rest of the Network domain
          return;
      }
    },
  );

  // Emits targetCreated for every target already alive, then for each new one.
  await cdp.send("Target.setDiscoverTargets", { discover: true });

  return {
    requests,
    workers: () =>
      [...running.values()].map((w) => ({
        url: w.url,
        recording: w.sessionId !== undefined && w.enabled,
      })),
    async release(workerUrl) {
      for (const worker of running.values()) {
        const sessionId = worker.sessionId;
        if (sessionId === undefined) continue;
        if (workerUrl !== undefined && worker.url !== workerUrl) continue;
        worker.sessionId = undefined;
        sessions.delete(sessionId);
        enableCalls.delete(sessionId);
        await cdp.send("Target.detachFromTarget", { sessionId });
      }
    },
    async stop() {
      await cdp.detach();
    },
  };
}
