import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  reportOutboxWatcher,
  startReportOutbox,
  stopReportOutbox,
} from "./internal/watcher";
import {
  outboxFatalWriter,
  outboxWriter,
  resolveWriterRepo,
  settleOutboxWrites,
} from "./internal/writer";

export default {
  description:
    "Report outbox writer and drain: writes every report recordReport hands to the engine's reportOutboxSink (a process that cannot write reports — an exec child, a CLI) into the outbox, in every boot mode, awaiting the writes on shutdown, and every fatal report (reportOutboxFatalSink) synchronously, before the process exits; and on main only, records every report a process with no server (a CLI run, a supervised child) wrote into the host-global outbox — once at boot, then on each file change (no polling). An entry whose code main has changed since the writer's branch point (git diff of its paths) is dropped and logged; one from another repository (the writer stamps its own) is filed without that check, its message saying where it came from; an entry that cannot be filed (bad JSON, unknown kind, rejected payload, undecidable staleness) becomes a server-caught crash report and is deleted.",
  register: [reportOutboxWatcher],
  sinkHandlers: [outboxWriter, outboxFatalWriter],
  // Every boot mode: the synchronous writer's repository stamp, known before
  // any registered work (an exec child's body) can exit fatally.
  onReadyBlocking: async () => {
    await resolveWriterRepo();
  },
  onReady: () => {
    startReportOutbox();
  },
  onShutdown: async () => {
    await stopReportOutbox();
    // An exec child's shutdown runs this before it exits.
    await settleOutboxWrites();
  },
} satisfies ServerPluginDefinition;
