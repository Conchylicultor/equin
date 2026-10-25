import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  Text,
  textVariantClass,
  type TextProps,
  type TextVariant,
  type TextTone,
  type TruncateSide,
} from "./internal/text";
export { rolePickClass, rolePickScope } from "./internal/role-pick";
export { SectionLabel, type SectionLabelProps } from "./internal/section-label";

export default {
  description:
    "Semantic typography primitive: <Text variant tone as> (or <Text pick> — a role the theme picks per part through three tokens, applied by CSS style queries) picks a frozen size/line-height/weight role from the typography token group (incl. the eyebrow/section-label role). The single sanctioned home for text hierarchy; raw text-size/leading-* is banned by no-adhoc-typography.",
  contributions: [],
} satisfies PluginDefinition;
