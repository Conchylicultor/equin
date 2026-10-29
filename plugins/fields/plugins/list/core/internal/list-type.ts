import {
  defineFieldType,
  defineFieldIdentity,
  type FieldsRecord,
  type InferFieldsObject,
} from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const listIcon = symbol("list");

export type ListItem<F extends FieldsRecord> = {
  id: string;
} & InferFieldsObject<F>;

export const listFieldType = defineFieldType<ListItem<FieldsRecord>[]>("list");

export const listIdentity = defineFieldIdentity<ListItem<FieldsRecord>[]>({
  type: listFieldType,
  kind: "label",
  label: "List",
  icon: listIcon,
});
