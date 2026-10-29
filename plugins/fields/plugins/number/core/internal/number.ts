import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const numbersIcon = symbol("numbers");

export const numberFieldType = defineFieldType<number>("number");

export const numberIdentity = defineFieldIdentity<number>({
  type: numberFieldType,
  kind: "quantity",
  label: "Number",
  icon: numbersIcon,
  customColumn: true,
  coerce: (v) => (typeof v === "number" ? v : Number(v)),
  directionLabels: { asc: "1 → 9", desc: "9 → 1" },
});
