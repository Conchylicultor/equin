import { FILE_TEXT_MAX_BYTES } from "@plugins/infra/plugins/paths/plugins/file-systems/core";

/** How many leading bytes the binary sniff inspects. */
const SNIFF_BYTES = 8000;

/** What a run of bytes is as text: decoded, too big to decode, or binary. */
export type TextBytesResult =
  | { kind: "ok"; content: string }
  | { kind: "too-large"; size: number }
  | { kind: "binary" };

/** A NUL byte in the first 8 KB — the same heuristic git and grep use. */
function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, Math.min(bytes.length, SNIFF_BYTES)).includes(0);
}

/**
 * Decode file bytes as UTF-8 text, refusing more than `FILE_TEXT_MAX_BYTES`
 * and anything binary-sniffed. The one text gate every file reader shares —
 * host-fs `text` and code-explorer's git-ref reads alike — so they cannot
 * disagree about what "too large" or "binary" means.
 */
export function decodeTextBytes(bytes: Uint8Array): TextBytesResult {
  if (bytes.length > FILE_TEXT_MAX_BYTES)
    return { kind: "too-large", size: bytes.length };
  if (looksBinary(bytes)) return { kind: "binary" };
  return { kind: "ok", content: new TextDecoder().decode(bytes) };
}
