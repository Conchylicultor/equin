import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  Stack,
  selfClass,
  type StackProps,
  type StackDirection,
  type StackAlign,
  type StackJustify,
} from "./internal/stack";
export {
  Inset,
  insetClass,
  type InsetProps,
  type InsetSides,
} from "./internal/inset";
export {
  FirstLine,
  firstLineClass,
  type FirstLineProps,
} from "./internal/first-line";

export default {
  description:
    "Layout spacing primitives: <Stack gap> (flex + gap) and <Inset pad> (padding) draw from the closed density spacing ramp declared in primitives/css/space-ramp, plus insetClass() — the same padding resolver as a class string, for consumers that only accept a className — and selfClass(align), one child's cross-axis override (the same StackAlign union as <Stack align>, seen from the child), which is class-only because a wrapper would become the flex item and take the alignment itself — and <FirstLine> / firstLineClass(), the one-line-tall box that seats a leading mark on the first line of the text beside it (the structural replacement for an optical mt-0.5 nudge). The sanctioned home for layout rhythm; raw gap-/p-/m-/space- Tailwind is banned by no-adhoc-spacing.",
  contributions: [],
} satisfies PluginDefinition;
