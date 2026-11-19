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
 * A worker ends as it would untapped. Chromium keeps the host of a worker a
 * debugger is attached to past its end — it reports `Inspector.targetCrashed`
 * and RESTARTS the script in that host for the next page that connects by its
 * name (`Inspector.targetReloadedAfterCrash`), a restart that never answers
 * that page: a returning visit's demo host stayed on "starting" for good, the
 * live socket's reads fell back to HTTP. So the tap detaches from a worker the
 * moment it ends: the host goes, the next page starts a fresh worker, and the
 * tap attaches to that one like any other.
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
  /** When it was sent (epoch ms). */
  sentAt?: number;
  /** When its last byte arrived (epoch ms); absent until it finished. */
  finishedAt?: number;
  /** Bytes received on the wire for it (headers and the body as sent: compressed when it was). */
  encodedBytes?: number;
  /** The response's `Content-Encoding` (`br`, `gzip`), absent when sent as is. */
  contentEncoding?: string;
}

export interface SharedWorkerTap {
  /** Every request seen so far, in issue order (each entry updated as it is answered). */
  readonly requests: readonly SharedWorkerRequest[];
  /** The SharedWorkers still running. */
  workers(): readonly SharedWorkerState[];
  /** Detach from every worker and stop recording. */
  stop(): Promise<void>;
}

export interface SharedWorkerState {
  /** The worker's script URL. */
  url: string;
  /** Its requests are being recorded: attached, Network domain on. */
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
  targetId: string;
  url: string;
  /** The tap's session on it; absent before the attach and once the worker ended. */
  sessionId?: string;
  /** Its Network.enable was answered. */
  enabled: boolean;
}

/** What a tap does to each worker besides recording its requests. */
export interface SharedWorkerTapOptions {
  /**
   * CDP commands sent to each worker as soon as it is attached, before its
   * Network domain is on (e.g. `Emulation.setCPUThrottlingRate`, to run the
   * worker on a slower CPU as a page is). A command the worker refuses fails
   * the tap, loudly.
   */
  onAttach?: readonly { method: string; params?: Record<string, unknown> }[];
}

export async function tapSharedWorkerRequests(
  browser: Browser,
  options: SharedWorkerTapOptions = {},
): Promise<SharedWorkerTap> {
  const cdp: CDPSession = await browser.newBrowserCDPSession();
  const requests: SharedWorkerRequest[] = [];
  /** `<sessionId>:<requestId>` → entry (request ids are per target). */
  const pending = new Map<string, SharedWorkerRequest>();
  /** `<sessionId>:<requestId>` → when it was sent, on the wall and the monotonic clock CDP stamps its events with. */
  const sentClock = new Map<string, { wall: number; mono: number }>();
  /** sessionId → the worker, for the sessions still attached. */
  const sessions = new Map<string, RunningWorker>();
  /** targetId → the worker, while it runs. */
  const running = new Map<string, RunningWorker>();
  /** The id of each worker session's Network.enable call. */
  const enableCalls = new Map<string, number>();
  let nextId = 1;
  /** `stop()` was called: the browser session is gone. */
  let stopped = false;

  cdp.on(
    "Target.targetCreated",
    ({ targetInfo }: { targetInfo: TargetInfo }) => {
      if (targetInfo.type !== "shared_worker") return;
      const worker: RunningWorker = {
        targetId: targetInfo.targetId,
        url: targetInfo.url,
        enabled: false,
      };
      running.set(targetInfo.targetId, worker);
      const attach = async (): Promise<void> => {
        const { sessionId } = await cdp.send("Target.attachToTarget", {
          targetId: targetInfo.targetId,
          flatten: false,
        });
        worker.sessionId = sessionId;
        sessions.set(sessionId, worker);
        for (const command of options.onAttach ?? [])
          await cdp.send("Target.sendMessageToTarget", {
            sessionId,
            message: JSON.stringify({ id: nextId++, ...command }),
          });
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
      if (
        msg.method === "Inspector.targetCrashed" ||
        // A page reached the held host before the detach above landed.
        msg.method === "Inspector.targetReloadedAfterCrash"
      ) {
        // The worker ended (closed itself, or its last page left): let its
        // host go, or Chromium keeps it for the debugger (see above).
        void detach(sessionId).catch((err: unknown) => {
          // Its target already gone, or the tap stopped, takes the session with it.
          if (stopped || !running.has(worker.targetId)) return;
          throw err;
        });
        return;
      }
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
            sentAt: (p.wallTime as number) * 1000,
          };
          requests.push(entry);
          pending.set(key, entry);
          sentClock.set(key, {
            wall: (p.wallTime as number) * 1000,
            mono: (p.timestamp as number) * 1000,
          });
          return;
        }
        case "Network.responseReceived": {
          const entry = pending.get(key);
          if (entry === undefined) return;
          const response = p.response as {
            status: number;
            fromDiskCache?: boolean;
            fromPrefetchCache?: boolean;
            headers?: Record<string, string>;
          };
          entry.status = response.status;
          const encoding = Object.entries(response.headers ?? {}).find(
            ([name]) => name.toLowerCase() === "content-encoding",
          )?.[1];
          if (encoding !== undefined) entry.contentEncoding = encoding;
          entry.fromCache =
            response.fromDiskCache === true ||
            response.fromPrefetchCache === true;
          return;
        }
        case "Network.loadingFinished": {
          const entry = pending.get(key);
          const sent = sentClock.get(key);
          if (entry === undefined || sent === undefined) return;
          entry.encodedBytes = p.encodedDataLength as number;
          entry.finishedAt =
            sent.wall + (p.timestamp as number) * 1000 - sent.mono;
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

  /** Stop recording a worker's session and leave it, so its host can end. */
  async function detach(sessionId: string): Promise<void> {
    const worker = sessions.get(sessionId);
    if (worker === undefined) return;
    worker.sessionId = undefined;
    sessions.delete(sessionId);
    enableCalls.delete(sessionId);
    await cdp.send("Target.detachFromTarget", { sessionId });
  }

  // Emits targetCreated for every target already alive, then for each new one.
  await cdp.send("Target.setDiscoverTargets", { discover: true });

  return {
    requests,
    workers: () =>
      [...running.values()].map((w) => ({
        url: w.url,
        recording: w.sessionId !== undefined && w.enabled,
      })),
    async stop() {
      stopped = true;
      await cdp.detach();
    },
  };
}
