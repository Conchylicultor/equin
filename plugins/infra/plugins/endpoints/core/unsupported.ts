import { z } from "zod";

/**
 * The status a host answers an endpoint it does not serve with: `409` — the
 * server is real and reachable, that endpoint is simply not part of it.
 */
const UNSUPPORTED_STATUS = 409;

const unsupportedBody = z.object({
  reason: z.literal("unsupported"),
  method: z.string(),
  path: z.string(),
});

/**
 * The one spelling of an endpoint refusal: `409 { reason: "unsupported",
 * method, path }`. A host (e.g. a browser server standing in for the real one)
 * answers it for an endpoint it does not serve, and tells the user itself — so
 * a client recognising it (`isUnsupportedEndpointBody`) reports nothing more.
 */
export function unsupportedEndpointResponse(
  method: string,
  path: string,
): Response {
  return Response.json(
    { reason: "unsupported", method, path } satisfies z.infer<
      typeof unsupportedBody
    >,
    { status: UNSUPPORTED_STATUS },
  );
}

/**
 * What a host that is not the desktop server (a browser server, the browser
 * host's plugin graph) answers a request no route matches: an `/api/…` path is
 * the unsupported refusal (`unsupportedEndpointResponse` — the server is real,
 * that endpoint is simply not part of it), any other path a 404 naming it.
 * Shaped as `http-router`'s `onUnmatched`.
 */
export function unmatchedApiResponse(req: Request, pathname: string): Response {
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return unsupportedEndpointResponse(req.method, pathname);
  }
  return new Response(`Not found: ${pathname}`, { status: 404 });
}

/**
 * Whether a parsed error body is `unsupportedEndpointResponse`'s — a host's
 * refusal of an endpoint it does not serve, not a failure of the endpoint.
 */
export function isUnsupportedEndpointBody(body: unknown): boolean {
  return unsupportedBody.safeParse(body).success;
}

/** Whether a response's status and parsed body are an unsupported-endpoint refusal. */
export function isUnsupportedEndpointRefusal(
  status: number,
  body: unknown,
): boolean {
  return status === UNSUPPORTED_STATUS && isUnsupportedEndpointBody(body);
}

/**
 * Whether a response is an unsupported-endpoint refusal — for a host boundary
 * that tells the user itself (a decorator over a server), without consuming
 * the body the caller still reads (it reads a clone). Any status but 409
 * answers `false` before touching the body; a body that is not JSON (a plain
 * `HttpError` text) is not a refusal.
 */
export async function isUnsupportedEndpointResponse(
  res: Response,
): Promise<boolean> {
  if (res.status !== UNSUPPORTED_STATUS) return false;
  const raw = await res.clone().text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return false;
  }
  return isUnsupportedEndpointRefusal(res.status, body);
}
