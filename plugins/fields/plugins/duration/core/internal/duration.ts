import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { numberFieldType } from "@plugins/fields/plugins/number/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const durationIcon = symbol("timer");

export const durationFieldType = defineFieldType<number>("duration");

export const durationIdentity = defineFieldIdentity<number>({
  type: durationFieldType,
  kind: "duration",
  label: "Duration",
  icon: durationIcon,
  extends: numberFieldType,
  coerce: (v) => Number(v),
});
