import { z } from "zod";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import { canonicalJson } from "./draft-values";

/**
 * The URL spelling of a drafted surface's active view — one opaque value of the
 * pane's `;view.<surface>` key (the router never looks inside it):
 *
 * - `<viewId>` — the view as saved;
 * - `<viewId>~<base64url(canonicalJson(draft))>` — the view with its working
 *   copy, so the address reproduces the screen.
 *
 * base64url (RFC 4648 §5, no padding) over the UTF-8 bytes: `A–Z a–z 0–9 - _`,
 * none of which `encodeURIComponent` escapes, and never a `~` — so the first
 * `~` is the separator. A view id therefore cannot hold a `~` (`encodeViewAddress`
 * throws); derived ids are slugs and minted ids are `view-…`, so none does.
 */
export const DRAFT_SEPARATOR = "~";

/** What the draft part of a parsed address says. */
export type AddressDraft =
  | { kind: "none" }
  | { kind: "view"; view: VariantValue }
  /** A draft part that does not decode to a view value (a hand-edited or
   *  truncated link): carries no draft. */
  | { kind: "malformed" };

/** A parsed `;view.<surface>` value. */
export interface ViewAddress {
  viewId: string;
  draft: AddressDraft;
}

/** The address of `viewId` with `draft` as its working copy (`null`: none). */
export function encodeViewAddress(
  viewId: string,
  draft: VariantValue | null,
): string {
  if (viewId.includes(DRAFT_SEPARATOR)) {
    throw new Error(
      `view-core: view id "${viewId}" holds "${DRAFT_SEPARATOR}", the URL's draft separator`,
    );
  }
  return draft === null
    ? viewId
    : `${viewId}${DRAFT_SEPARATOR}${toBase64Url(canonicalJson(draft))}`;
}

/** Read an address written by {@link encodeViewAddress}. */
export function parseViewAddress(value: string): ViewAddress {
  const at = value.indexOf(DRAFT_SEPARATOR);
  if (at === -1) return { viewId: value, draft: { kind: "none" } };
  return {
    viewId: value.slice(0, at),
    draft: decodeDraft(value.slice(at + 1)),
  };
}

/** The shape every stored working copy has (the drafts store's own schema). */
const draftSchema = z.object({ type: z.string() }).passthrough();

function decodeDraft(part: string): AddressDraft {
  const json = fromBase64Url(part);
  if (json === null) return { kind: "malformed" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    if (err instanceof SyntaxError) return { kind: "malformed" };
    throw err;
  }
  const result = draftSchema.safeParse(parsed);
  return result.success
    ? { kind: "view", view: result.data as VariantValue }
    : { kind: "malformed" };
}

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** The UTF-8 text `part` encodes, or `null` when it is not base64url of UTF-8. */
function fromBase64Url(part: string): string | null {
  // Checked up front, so `atob` cannot throw: only the alphabet, and never a
  // length no unpadded base64 has (a lone trailing character).
  if (part === "" || !BASE64URL.test(part) || part.length % 4 === 1) {
    return null;
  }
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    // `fatal` throws a TypeError on bytes that are not UTF-8.
    if (err instanceof TypeError) return null;
    throw err;
  }
}
