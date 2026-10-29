import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { textFieldType } from "@plugins/fields/plugins/text/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const notesIcon = symbol("notes");

export const multilineTextFieldType = defineFieldType<string>("multiline-text");

export const multilineTextIdentity = defineFieldIdentity<string>({
  type: multilineTextFieldType,
  kind: "prose",
  label: "Long text",
  icon: notesIcon,
  extends: textFieldType,
  coerce: (v) => (typeof v === "string" ? v : String(v ?? "")),
});
