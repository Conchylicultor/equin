import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { textFieldType } from "@plugins/fields/plugins/text/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const codeIcon = symbol("code");

/**
 * A code identifier — a commit sha, a run id, a fingerprint, a slug, a tool
 * name: a string a person copies and compares, never reads as prose.
 */
export const identifierFieldType = defineFieldType<string>("identifier");

export const identifierIdentity = defineFieldIdentity<string>({
  type: identifierFieldType,
  label: "Identifier",
  icon: codeIcon,
  extends: textFieldType,
});
