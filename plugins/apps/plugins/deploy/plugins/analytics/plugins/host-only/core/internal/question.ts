import { z } from "zod";

// How a host-only route's question travels: ONE base64url query-string value
// (`?q=`). base64url's alphabet (`A-Z a-z 0-9 - _`) needs no quoting in a URL
// nor in the remote shell `sshRun` joins its argv into, so the deploy app can
// curl it over SSH as-is (host-query refuses any other character).

export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The default bound of an encoded question, in characters: a report or
 * sessions question is a few hundred. A route whose question carries a list
 * (the table mirror's keys) states its own, below what the box's HTTP server
 * accepts in a request line.
 */
export const DEFAULT_QUESTION_MAX_CHARS = 4096;

/** A value as one base64url query-string value (its JSON, UTF-8). */
export function encodeBase64UrlJson(value: unknown): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** The JSON text inside an encoded question. Throws on a value that is not base64url. */
export function decodeBase64UrlJson(encoded: string): string {
  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new Error("host-only question: not base64url");
  }
  const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}

/**
 * The `?q=` query-string schema of a question `schema`: decodes and validates
 * in one step. `maxChars` bounds the encoded value
 * ({@link DEFAULT_QUESTION_MAX_CHARS} unless stated).
 */
export function base64UrlJsonParamSchema<S extends z.ZodType>(
  schema: S,
  opts: { maxChars?: number } = {},
) {
  return z
    .object({
      q: z
        .string()
        .max(opts.maxChars ?? DEFAULT_QUESTION_MAX_CHARS)
        .regex(BASE64URL_PATTERN)
        .transform((encoded, ctx) => {
          try {
            return JSON.parse(decodeBase64UrlJson(encoded)) as unknown;
          } catch (err) {
            // atob's malformed-length DOMException, JSON.parse's SyntaxError:
            // both are a bad request, not a server fault.
            if (!(err instanceof SyntaxError || err instanceof DOMException)) {
              throw err;
            }
            ctx.addIssue({
              code: "custom",
              message: "q is not base64url-encoded JSON",
            });
            return z.NEVER;
          }
        })
        .pipe(schema),
    })
    .strict();
}
