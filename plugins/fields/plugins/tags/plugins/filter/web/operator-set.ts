import type { FilterOperatorSet } from "@plugins/primitives/plugins/data-view/web";
import { TagSingleInput, TagMultiInput } from "./components/tags-filter";
import { tagsLower } from "./internal/tags-lower";

export const tagsOperatorSet: FilterOperatorSet = {
  match: "tags",
  domain: "stringArray",
  defaultOperator: "contains",
  operators: [
    {
      id: "contains",
      label: "Contains",
      hasValue: true,
      ValueInput: TagSingleInput,
      lower: tagsLower.contains,
    },
    {
      id: "does-not-contain",
      label: "Does not contain",
      hasValue: true,
      ValueInput: TagSingleInput,
      lower: tagsLower["does-not-contain"],
    },
    {
      id: "contains-any-of",
      label: "Contains any of",
      hasValue: true,
      ValueInput: TagMultiInput,
      lower: tagsLower["contains-any-of"],
    },
    {
      id: "contains-all-of",
      label: "Contains all of",
      hasValue: true,
      ValueInput: TagMultiInput,
      lower: tagsLower["contains-all-of"],
    },
    {
      id: "has-nested",
      label: "Has any of (incl. nested)",
      hasValue: true,
      ValueInput: TagMultiInput,
      lower: tagsLower["has-nested"],
    },
    {
      id: "lacks-nested",
      label: "Has none of (incl. nested)",
      hasValue: true,
      ValueInput: TagMultiInput,
      lower: tagsLower["lacks-nested"],
    },
    {
      id: "is-empty",
      label: "Is empty",
      hasValue: false,
      lower: tagsLower["is-empty"],
    },
    {
      id: "is-not-empty",
      label: "Is not empty",
      hasValue: false,
      lower: tagsLower["is-not-empty"],
    },
  ],
};
