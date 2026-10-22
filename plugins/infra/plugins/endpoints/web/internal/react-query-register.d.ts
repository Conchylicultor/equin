// Global mutation meta type — available on any useMutation/useEndpointMutation call.
// suppressError: true  → silence the global auto-toast (handle locally instead).
// When onError is provided, suppressError defaults to true automatically.
//
// A declaration-only file: an augmentation is seen by every file without being
// imported, so the type check keys every file on this file's version — in a
// source file, every edit to it would re-check the whole repo
// (`type-check/no-global-declaration-in-source`).
import "@tanstack/react-query";

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      suppressError?: boolean;
    };
  }
}
