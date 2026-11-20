import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import type { BoxHelloInfo } from "@plugins/apps/plugins/deploy/plugins/box-link/core";

/** Told a deployment's box raised a signal of the source subscribed to. */
export type BoxSignalHandler = (deploymentId: string, payload: unknown) => void;
/** Told a deployment's box said hello: the link (re)connected. */
export type BoxHelloHandler = (
  deploymentId: string,
  hello: BoxHelloInfo,
) => void;

const signalHandlers = new Map<string, Set<BoxSignalHandler>>();
const helloHandlers = new Set<BoxHelloHandler>();

/**
 * Call `fn` whenever a linked box raises a signal of `source` (a `BoxSignal`
 * contribution on the box). `payload` is the source's own vocabulary: parse
 * it with the owning plugin's schema. A signal is a doorbell — one may be
 * lost (the link was down); `onBoxHello` is the catch-up. Returns the
 * unsubscribe.
 */
export function onBoxSignal(source: string, fn: BoxSignalHandler): () => void {
  let set = signalHandlers.get(source);
  if (set === undefined) {
    set = new Set();
    signalHandlers.set(source, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

/**
 * Call `fn` whenever a linked box says hello — on every (re)connect, after
 * which every signal is heard: read whatever may have been missed while the
 * link was down. Returns the unsubscribe.
 */
export function onBoxHello(fn: BoxHelloHandler): () => void {
  helloHandlers.add(fn);
  return () => {
    helloHandlers.delete(fn);
  };
}

// A throwing handler is the handler's bug: filed, and the stream (and the
// other handlers) go on.
function call(scope: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    reportServerError({
      message: `[box-link] a ${scope} handler threw: ${err instanceof Error ? err.message : String(err)}`,
      ...crashFieldsOf(err, `box-link:${scope}`),
    });
  }
}

export function dispatchBoxSignal(
  deploymentId: string,
  source: string,
  payload: unknown,
): void {
  for (const fn of signalHandlers.get(source) ?? []) {
    call(`signal:${source}`, () => fn(deploymentId, payload));
  }
}

export function dispatchBoxHello(
  deploymentId: string,
  hello: BoxHelloInfo,
): void {
  for (const fn of helloHandlers) call("hello", () => fn(deploymentId, hello));
}
