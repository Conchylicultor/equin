import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { numberFieldType } from "@plugins/fields/plugins/number/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const byteSizeIcon = symbol("hard-drive");

export const byteSizeFieldType = defineFieldType<number>("byte-size");

export const byteSizeIdentity = defineFieldIdentity<number>({
  type: byteSizeFieldType,
  label: "Byte size",
  icon: byteSizeIcon,
  extends: numberFieldType,
  coerce: (v) => Number(v),
});
