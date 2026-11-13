import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { SinkDrain } from "@plugins/primitives/plugins/report-sink/web";

export const ReportSinks = {
  /**
   * A collector of another plugin's sink: `from` is the id of the plugin that
   * declares (and emits into) the sink, `collect` is `drain(sink, handler)`.
   * The collector host registers it while mounted.
   *
   * A companion keyed by `from` in the `plugin` space: the collector ships
   * where this plugin (the opt-in, named by the `reporters` pack) AND its
   * producer both ship — never on its own. A collector importing its producer
   * and named by the pack would carry the producer into every composition
   * that extends it: the page editor (Lexical, yjs) into the public website's
   * eager set, through three editor-only collectors. `companion: true` is required, and
   * `report-sink/collector-from-matches` holds `from` to the plugin that
   * really declares the sink.
   */
  Collector: defineSlot<{
    from: string;
    collect: SinkDrain;
    companion: true;
  }>({
    docLabel: (p) => p.from,
    companions: { key: "from", space: "plugin" },
  }),
};
