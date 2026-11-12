// What a crash collector caught, in words, when the thing itself carries none.
//
// A report's message is required and non-empty (reports/core's
// ReportBodySchema): it is the one line a stackless crash is identified and
// diagnosed by. An `error` event or a rejection does not always bring one — a
// `new Error()`, a `throw ""`, a rejection with `undefined`, an ErrorEvent
// dispatched without a message — so the collector says what it DID see: the
// event's type, its target, where it was raised, and what was thrown. Never a
// stand-in: each part is a fact read off the event.

/** A DOM node or other event target, named by what it is. */
export function describeTarget(target: EventTarget | null): string {
  if (target === null) return "no target";
  if (typeof window !== "undefined" && target === window) return "window";
  if (typeof Element !== "undefined" && target instanceof Element) {
    const id = target.id ? `#${target.id}` : "";
    const src =
      target.getAttribute("src") ?? target.getAttribute("href") ?? null;
    return `<${target.tagName.toLowerCase()}${id}>${src ? ` ${src}` : ""}`;
  }
  return target.constructor?.name || "an event target";
}

/** A thrown or rejected value that is not an Error, named by its shape. */
export function describeThrown(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") {
    return value === "" ? "an empty string" : JSON.stringify(value);
  }
  if (typeof value === "object") {
    const name = value.constructor?.name ?? "Object";
    const keys = Object.keys(value).slice(0, 5);
    return keys.length === 0
      ? `a ${name} with no own keys`
      : `a ${name} {${keys.join(", ")}}`;
  }
  return `${typeof value} ${String(value)}`;
}

/** An Error's message, or — a `new Error()` — its type saying it has none. */
export function describeError(err: Error): string {
  return err.message !== "" ? err.message : `${err.name} with no message`;
}

/** The message of a window `error` event: the error's, else the event's facts. */
export function describeErrorEvent(e: ErrorEvent): string {
  if (e.error instanceof Error) return describeError(e.error);
  if (e.message !== "") return e.message;
  const where = e.filename ? ` at ${e.filename}:${e.lineno}:${e.colno}` : "";
  const thrown =
    e.error === undefined || e.error === null
      ? ""
      : `, thrown value ${describeThrown(e.error)}`;
  return `${e.type} event on ${describeTarget(e.target)} with no message${where}${thrown}`;
}

/** The message of an unhandled rejection: the error's, else the reason's shape. */
export function describeRejection(e: PromiseRejectionEvent): string {
  if (e.reason instanceof Error) return describeError(e.reason);
  if (typeof e.reason === "string" && e.reason !== "") return e.reason;
  return `Unhandled rejection with ${describeThrown(e.reason)}`;
}
