import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const keyIcon = symbol("key");

export const secretFieldType = defineFieldType<string>("secret");

export const secretIdentity = defineFieldIdentity<string>({
  type: secretFieldType,
  kind: "label",
  label: "Secret",
  icon: keyIcon,
});
