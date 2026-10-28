import type { NumberOperandUnits } from "@plugins/fields/plugins/number/plugins/filter/web";
import {
  formatDuration,
  parseDuration,
} from "@plugins/fields/plugins/duration/core";

/** A duration operand is typed as a span (`30s`, `5m`, `1h`; a bare number is ms). */
export const durationOperandUnits: NumberOperandUnits = {
  parse: parseDuration,
  format: formatDuration,
  placeholder: "e.g. 30s, 5m",
};
