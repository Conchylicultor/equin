import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { textFieldType } from "@plugins/fields/plugins/text/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const personIcon = symbol("person");

/** A person's display name — free text, drawn beside an initial avatar. */
export const personFieldType = defineFieldType<string>("person");

export const personIdentity = defineFieldIdentity<string>({
  type: personFieldType,
  kind: "person",
  label: "Person",
  icon: personIcon,
  extends: textFieldType,
});
