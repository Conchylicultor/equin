/**
 * Whether `new URL(raw, base)` parses — `URL.canParse`, spelled with the
 * constructor so it runs on every browser of the floor (`URL.canParse` is
 * Safari 17 / Chrome 120 / Firefox 115; equin.ai's home page crashed on it on
 * 2026-11-19). The constructor throws a `TypeError` on an invalid URL, and
 * only then.
 */
export function canParseUrl(raw: string | URL, base?: string | URL): boolean {
  try {
    new URL(raw, base);
    return true;
  } catch (err) {
    if (err instanceof TypeError) return false;
    throw err;
  }
}

/**
 * `new URL(raw, base)`, or null when it does not parse — `URL.parse` (Safari
 * 18 / Chrome 126 / Firefox 126), spelled for the floor.
 */
export function parseUrl(raw: string | URL, base?: string | URL): URL | null {
  return canParseUrl(raw, base) ? new URL(raw, base) : null;
}

/**
 * A JSON response — `Response.json(body, init)` (Safari 17), spelled for the
 * floor: the body serialized, `content-type: application/json;charset=utf-8`
 * (Bun's spelling, which the backends answered with until now) unless `init`
 * sets one. The in-browser server answers its requests through this on a
 * visitor's browser, so it must run on every floor browser.
 */
export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type"))
    headers.set("content-type", "application/json;charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** What `Promise.withResolvers` returns. */
export interface Resolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/**
 * A promise and the functions that settle it — `Promise.withResolvers()`
 * (Safari 17.4 / Chrome 119 / Firefox 121), spelled for the floor.
 */
export function promiseWithResolvers<T>(): Resolvers<T> {
  let resolve!: Resolvers<T>["resolve"];
  let reject!: Resolvers<T>["reject"];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
