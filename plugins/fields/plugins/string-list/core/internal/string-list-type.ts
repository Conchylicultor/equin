import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { tagsFieldType } from "@plugins/fields/plugins/tags/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const formatListBulletedIcon = symbol("format-list-bulleted");

export const stringListFieldType = defineFieldType<string[]>("string-list");

// A string list reads and filters like tags in a list (each value a chip,
// "contains" one value): it `extends` tags, so a list field of it (a run's
// build targets) takes the tags cell and filter. Its own settings renderer
// stays its own.
export const stringListIdentity = defineFieldIdentity<string[]>({
  type: stringListFieldType,
  label: "String List",
  icon: formatListBulletedIcon,
  extends: tagsFieldType,
});
