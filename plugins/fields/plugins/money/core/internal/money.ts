import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { floatFieldType } from "@plugins/fields/plugins/float/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const moneyIcon = symbol("payments");

export const moneyFieldType = defineFieldType<number>("money");

export const moneyIdentity = defineFieldIdentity<number>({
  type: moneyFieldType,
  label: "Money",
  icon: moneyIcon,
  extends: floatFieldType,
  coerce: (v) => Number(v),
});
