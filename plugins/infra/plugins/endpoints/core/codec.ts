import type { z } from "zod";
import { HttpError } from "./http-error";

/**
 * A transport codec for an endpoint body/response payload.
 *
 * The default codec is `json()` (a bare Zod schema in a `body:`/`response:` slot
 * is normalized to `json(schema)`). Non-JSON payloads opt into `blob()` /
 * `multipart()` in the same slot.
 *
 * - `encodeRequest`/`decodeRequest` are the client→server (request body) pair.
 * - `encodeResponse`/`decodeResponse` are the server→client (response body) pair.
 */
export interface Codec<T> {
  encodeRequest(value: T): { body: BodyInit; contentType?: string };
  decodeRequest(req: Request): Promise<T>;
  encodeResponse(value: T): Response;
  decodeResponse(res: Response): Promise<T>;
}

export function isCodec(x: unknown): x is Codec<unknown> {
  return typeof x === "object" && x !== null && "encodeRequest" in x;
}

/**
 * Default JSON codec. Mirrors the legacy hardwired behavior exactly:
 * `JSON.stringify` + `application/json` on the way out, `req.json()` /
 * `res.json()` on the way in, optionally validated through a Zod schema.
 *
 * Internal — callers write a bare Zod schema (or omit it for raw JSON), which
 * `defineEndpoint` normalizes to `json(schema)`.
 */
export function json<T>(schema?: z.ZodType<T>): Codec<T> {
  return {
    encodeRequest(value) {
      return { body: JSON.stringify(value), contentType: "application/json" };
    },
    async decodeRequest(req) {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch (err) {
        // Only a malformed body is a 400; a stream/transport error is a real
        // failure that must surface, not be masked as client error.
        if (!(err instanceof SyntaxError)) throw err;
        throw new HttpError(400, "Invalid JSON body");
      }
      if (!schema) return raw as T;
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw new HttpError(
          400,
          JSON.stringify({
            error: "Validation failed",
            issues: result.error.issues,
          }),
        );
      }
      return result.data;
    },
    encodeResponse(value) {
      return Response.json(value);
    },
    async decodeResponse(res) {
      const raw: unknown = await res.json();
      return schema ? schema.parse(raw) : (raw as T);
    },
  };
}

/** Binary blob codec. Optional `contentType` overrides the request content-type. */
export function blob(contentType?: string): Codec<Blob> {
  return {
    encodeRequest(value) {
      return { body: value, contentType };
    },
    decodeRequest(req) {
      return req.blob();
    },
    encodeResponse(value) {
      return new Response(
        value,
        value.type ? { headers: { "content-type": value.type } } : undefined,
      );
    },
    decodeResponse(res) {
      return res.blob();
    },
  };
}

/**
 * Multipart form-data codec. Request-only: the browser sets the multipart
 * boundary, so `encodeRequest` emits NO content-type. Never valid in a
 * `response:` slot.
 */
export function multipart(): Codec<FormData> {
  return {
    encodeRequest(value) {
      return { body: value };
    },
    async decodeRequest(req) {
      try {
        return await req.formData();
      } catch (err) {
        // Wrong content-type or malformed multipart body → 400, not a 500.
        if (!(err instanceof TypeError) && !(err instanceof SyntaxError))
          throw err;
        throw new HttpError(400, "Invalid multipart body");
      }
    },
    encodeResponse(): Response {
      throw new Error("multipart is request-only");
    },
    decodeResponse(): Promise<FormData> {
      throw new Error("multipart is request-only");
    },
  };
}
