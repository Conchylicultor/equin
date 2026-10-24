import {
  setClientBuildIdentity,
  type Registration,
} from "@plugins/framework/plugins/server-core/core";
import { getServerGraphHash } from "./get-server-graph-hash";

// The build graph the live-resource runtime judges a contract mismatch against
// (`setClientBuildIdentity`): a tab whose bundle names another graph is out of
// date — skew, warned — while one naming this graph has a real bug — reported.
//
// Read ONCE, at the register phase, and memoized — the one reader here that is
// NOT fresh per call, and deliberately so. The question is "which bundle was
// this PROCESS's code built with?", and `./equin build` swaps the served
// dist before it restarts this backend: a fresh read in that window names the
// NEW bundle while the old code still answers, and would call a current tab's
// mismatch "same-build" (or an old tab's "skew" of the wrong build). At boot
// the dist is already the one built alongside this code.
export const clientBuildIdentityRegistration: Registration = {
  register() {
    const bootGraph = getServerGraphHash();
    setClientBuildIdentity(() => bootGraph);
  },
};
