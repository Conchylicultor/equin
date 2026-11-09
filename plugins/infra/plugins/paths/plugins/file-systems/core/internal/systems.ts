import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

/**
 * The file systems this host serves — the ones whose own plugin booted here
 * and contributed `FileSystems.Provide` (the computer's disk on the desktop,
 * the browser's storage in a browser host). A system missing from it is
 * ABSENT here: a browser lists no place of it and a link to one of its files
 * says so, rather than reading a system nobody answers. Fixed per build.
 * Boot-preloaded and kept: Files' Home and every browser's Places read it
 * first, and it never changes, so no surface waits on it.
 */
export const fileSystemsServed = liveValue("files.systems", {
  schema: wholeList(z.enum(["computer", "browser", "checkout"]), {
    reason: "the closed set of file systems, at most one entry each",
  }),
  preload: "boot-and-keep",
});
