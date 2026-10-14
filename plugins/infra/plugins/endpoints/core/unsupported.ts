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
