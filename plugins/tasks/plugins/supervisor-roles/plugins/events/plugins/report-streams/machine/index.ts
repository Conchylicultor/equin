import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  errorReportsStream,
  reportEventJob,
  reportRecordedToStreams,
  slowOpReportsStream,
} from "./internal/streams";

export default {
  description:
    "The report event streams: Error reports and Slow-op reports (the kinds whose `category` is error / slow-op), each fed every recorded report of its category — one event per occurrence, keyed by the report so its occurrences fold into one line of the supervisor's next message.",
  contributions: [
    errorReportsStream,
    slowOpReportsStream,
    reportRecordedToStreams,
  ],
  register: [reportEventJob],
} satisfies MachinePluginDefinition;
