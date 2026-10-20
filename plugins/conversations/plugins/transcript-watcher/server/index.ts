import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  startTranscriptWatcher,
  stopTranscriptWatcher,
  transcriptsWatcher,
} from "./internal/watcher";
import { foreignSessionKind } from "./internal/foreign-session-kind";

export {
  watchTranscript,
  watchTranscriptFile,
  refreshConversationChain,
  conversationChainTag,
  // The generic room. A consumer whose files are DISCOVERED (a directory whose
  // contents decide the set) binds it directly with `dirs`, so a file created
  // there reaches the room at the moment it is born — the one thing exact-path
  // dispatch cannot do. Everything still rides the single parcel subscription
  // and the single reconcile sweep.
  watchPaths,
} from "./internal/watcher";
export type {
  TranscriptSnapshot,
  PathsSnapshot,
  WatchTargets,
  WatchSpec,
} from "./internal/watcher";
// The BOUND signature only. `statChain` / `chainEtag` / `chainFileEtag` stay internal:
// a consumer that assembles its own signature from the halves is a second authority.
export { transcriptChainSignature } from "./internal/chain-signature";
export {
  readJsonlEvents,
  readJsonlEventsFromChain,
  readChainLines,
} from "./internal/parse-jsonl";
export { findTranscriptPath } from "./internal/find-transcript-path";
// Every session transcript written on the host, room or not — how a waiter on a
// transcript that does not exist yet (the status reconciler's session-id gate)
// learns that it now does.
export { onSessionTranscriptWritten } from "./internal/session-writes";
// Every session OR sub-agent transcript written on the host, keyed by the owning
// session id — how an accumulator over a conversation's whole tree (its usage
// totals) hears about a sub-agent's append.
export { onTranscriptWritten } from "./internal/session-writes";
export { resolveConversationTranscriptPaths } from "./internal/resolve-chain";
// The ownership partition itself, for consumers that need the rejected half —
// a monitor auditing chains, or the status reconciler's adoption gate — rather than just
// the files to read.
export { resolveAnchoredChain } from "./internal/anchor";
export type { AnchoredChain, AnchoredEntry } from "./internal/anchor";

export default {
  description:
    "Single @parcel/watcher-based JSONL transcript watcher. Replaces two independent 500ms pollers with one fan-out subscription.",
  contributions: [foreignSessionKind],
  register: [transcriptsWatcher],
  onReady: async () => {
    await startTranscriptWatcher();
  },
  onShutdown: async () => {
    await stopTranscriptWatcher();
  },
} satisfies ServerPluginDefinition;
