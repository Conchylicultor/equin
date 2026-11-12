// The shared-ws worker, run inside the page — for a browser without
// SharedWorker or Web Locks (Chrome for Android before 148, Android System
// WebView: Instagram's, Facebook's, LinkedIn's in-app browsers).
//
// The SAME host logic the SharedWorker runs (`createSharedWsHost`), reached
// over a real `MessageChannel`, with an in-page exclusive lock standing in for
// `navigator.locks` — so the tab client (`SharedWebSocket`) and everything a
// consumer sees (queue-until-open, reconnects, `onopen` once per connection,
// addressed frames, last wills, bfcache detach) are unchanged. What is lost is
// only the sharing: each page holds its own socket per URL, and the page's
// liveness is the page itself (it dies, its socket dies with it; the server
// sees the close).
//
// Never imported by the worker entry: it reaches past the page request guard
// (`nativeWebSocket`), which only page code may.

import { createSharedWsHost, type SharedWsHost } from "./shared-ws-host";
import type {
  LockManagerLike,
  MakeSharedWorker,
  MakeWebSocket,
} from "./transport-types";

/**
 * An exclusive lock per name, held while its callback's promise is pending and
 * granted to waiters in arrival order — the subset of `navigator.locks` the
 * shared-ws stack uses, within one page. Like the real API, a grant is never
 * synchronous, and `request` settles with the callback's outcome.
 */
export function createInPageLocks(): LockManagerLike {
  /** A name is held while it has an entry; the entry is its waiters. */
  const held = new Map<string, (() => void)[]>();
  const release = (name: string): void => {
    const next = held.get(name)?.shift();
    if (next) next();
    else held.delete(name);
  };
  return {
    request(name, _options, callback) {
      return new Promise<void>((resolve, reject) => {
        const run = (): void => {
          let result: Promise<void> | void;
          try {
            result = callback();
          } catch (err) {
            release(name);
            reject(err);
            return;
          }
          Promise.resolve(result).then(
            () => {
              release(name);
              resolve();
            },
            (err: unknown) => {
              release(name);
              reject(err);
            },
          );
        };
        const waiters = held.get(name);
        if (waiters) waiters.push(run);
        else {
          held.set(name, []);
          queueMicrotask(run);
        }
      });
    },
  };
}

/**
 * A `MakeSharedWorker` whose "workers" live in this page: one
 * `createSharedWsHost` per worker name (as the browser keeps one SharedWorker
 * per name), each tab-side handle a fresh `MessageChannel` connected to it the
 * way a SharedWorker's `connect` event would.
 */
export function createInPageSharedWorkers(deps: {
  makeWebSocket: MakeWebSocket;
  locks: LockManagerLike;
}): MakeSharedWorker {
  const hosts = new Map<string, SharedWsHost>();
  return (name) => {
    let host = hosts.get(name);
    if (!host) {
      host = createSharedWsHost(deps);
      hosts.set(name, host);
    }
    const channel = new MessageChannel();
    host.connect(channel.port2);
    return { port: channel.port1, onerror: null };
  };
}
