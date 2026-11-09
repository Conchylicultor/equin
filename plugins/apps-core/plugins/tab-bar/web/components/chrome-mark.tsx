import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { APP_RAIL_WIDTH } from "@plugins/apps-core/core";
import { Logo } from "@plugins/ui/plugins/logo/web";

/**
 * The app's mark at the tab bar's leading edge, in the column above the rail:
 * it anchors the frame's corner and lines the first tab up with the app's own
 * left edge. The equin logo (`ui/logo`) drawn in the current text colour, so
 * it is as quiet as the idle rail icons below it. Decorative — it does
 * nothing, so it is hidden from the a11y tree.
 */
export function ChromeMark() {
  return (
    <Center
      aria-hidden
      // eslint-disable-next-line layout/no-adhoc-layout -- rigid leading cell of the tab strip, as wide as the rail column below it
      className="h-full shrink-0"
      style={{ width: APP_RAIL_WIDTH }}
    >
      <Logo tone="current" className="size-4" />
    </Center>
  );
}
