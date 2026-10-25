import type { HttpHandler } from "@plugins/framework/plugins/server-core/core";

/**
 * Refuse a public request body over `maxBytes` before it is read. The declared
 * length is required: every browser `fetch` with a string body sends one, and
 * without it the size is unknowable until the whole body has been buffered.
 */
export function capBodySize(
  maxBytes: number,
  handler: HttpHandler,
): HttpHandler {
  return (req, params) => {
    const declared = req.headers.get("content-length");
    if (declared === null) {
      return new Response("Length required", { status: 411 });
    }
    const bytes = Number(declared);
    if (!Number.isInteger(bytes) || bytes < 0) {
      return new Response("Bad Content-Length", { status: 400 });
    }
    if (bytes > maxBytes) {
      return new Response("Payload too large", { status: 413 });
    }
    return handler(req, params);
  };
}
