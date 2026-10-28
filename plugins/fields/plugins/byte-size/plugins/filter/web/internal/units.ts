import type { NumberOperandUnits } from "@plugins/fields/plugins/number/plugins/filter/web";
import {
  formatByteSize,
  parseByteSize,
} from "@plugins/fields/plugins/byte-size/core";

/** A byte-size operand is typed as a size (`1 GB`, `500kB`; a bare number is bytes). */
export const byteSizeOperandUnits: NumberOperandUnits = {
  parse: parseByteSize,
  format: formatByteSize,
  placeholder: "e.g. 500kB, 1 GB",
};
