import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { intFieldType } from "@plugins/fields/plugins/int/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const ordinalIcon = symbol("format-list-numbered");

export const ordinalFieldType = defineFieldType<number>("ordinal");

export const ordinalIdentity = defineFieldIdentity<number>({
  type: ordinalFieldType,
  kind: "ordinal",
  label: "Ordinal",
  icon: ordinalIcon,
  extends: intFieldType,
  coerce: (v) => Math.trunc(Number(v)),
});
