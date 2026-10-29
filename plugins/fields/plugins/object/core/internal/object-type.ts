import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const dataObjectIcon = symbol("data-object");

export const objectFieldType =
  defineFieldType<Record<string, unknown>>("object");

export const objectIdentity = defineFieldIdentity<Record<string, unknown>>({
  type: objectFieldType,
  kind: "label",
  label: "Object",
  icon: dataObjectIcon,
});
