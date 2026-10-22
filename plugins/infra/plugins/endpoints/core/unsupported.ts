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
 * answers it for an endpoint it does not serve. The client treats it as any
 * other failure — thrown and reported: a browser host's coverage guard
 * (codegen's `browser-host-coverage.ts`) proves every endpoint its scoped page
 * calls is served or declared `needsMachine` (answered `unavailable` without a
 * request), so a refusal is a gap the guard missed.
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
