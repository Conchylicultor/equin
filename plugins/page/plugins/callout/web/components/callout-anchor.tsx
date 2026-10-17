import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { BlockAnchorProps } from "@plugins/page/plugins/editor/web";
import { ContainerAnchor } from "@plugins/page/plugins/container/web";
import {
  CalloutAppearanceFor,
  readCalloutAppearance,
} from "./callout-appearance";
import { COLOR_TEXT } from "./callout-colors";
import { runtimeSymbol, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const lightbulbIcon = symbol("lightbulb");

/**
 * The callout's leading glyph — the ONLY thing its row paints, and APPEARANCE
 * only.
 *
 * The structural actions (Remove callout / Delete / Collapse) used to live in
 * this popover, because an anchor row paints no hover rail and there was nowhere
 * else to hang a block-actions menu. There is now: the rail on the line the
 * callout BORROWS resolves the callout as its owner, so its `⠿` handle opens
 * them — generically, for every container. What is left here is what is
 * genuinely the callout's own: the glyph, and the icon/colour controls behind
 * it, which also render in that rail menu (`CalloutMenu`) so appearance is
 * reachable from both.
 *
 * The static-vs-interactive branch on `editor`, the `preventDefault`ed trigger
 * and the popover all still belong to `ContainerAnchor`; `panel` is the
 * callout's own, because its sections are a control panel (whose icon section
 * declares the `picker` width it needs).
 */
export function CalloutAnchor({ data, editor }: BlockAnchorProps) {
  const { icon, color } = readCalloutAppearance(data);

  return (
    <ContainerAnchor
      editor={editor}
      triggerLabel="Callout icon and color"
      // Its sections are a CONTROL PANEL; the icon grid's section declares the
      // `picker` width it needs.
      panel
      glyph={
        // The callout's icon is a saved Material Symbols name (unlike a
        // page's, which is an emoji), drawn as a runtime symbol.
        <Icon
          icon={icon != null ? runtimeSymbol(icon) : lightbulbIcon}
          className={cn("size-5", COLOR_TEXT[color])}
        />
      }
      sections={({ editor: api, close }) => (
        <CalloutAppearanceFor data={data} api={api} close={close} />
      )}
    />
  );
}
