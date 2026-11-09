import type { FileLocation } from "../../core";

/** A checkout location as its reads' question (`version` dropped when absent). */
export function checkoutQuery(
  location: Extract<FileLocation, { fs: "checkout" }>,
): { checkout: string; path: string; version?: string } {
  return {
    checkout: location.checkout,
    path: location.path,
    ...(location.version !== undefined ? { version: location.version } : {}),
  };
}
