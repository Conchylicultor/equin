import { InlineText } from "@plugins/primitives/plugins/inline-text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { GO_TINT, GoInlineUnit } from "./go-cap";
import { PickedBox } from "./picked-box";

const PICKED_RE = /^\s*[-*+] \[[xX]\] (.*)$/;

/**
 * A `<go>` in the USER's message — an agent suggestion they accepted, possibly
 * reworded — shown in full in the same tint the reply drew it in. A multi-line
 * region is a card; its `- [x]` lines (the picked items) read as checked boxes.
 * The words go through <InlineText>, so chips inside still render.
 */
export function GoEcho({ body }: { body: string }) {
  const text = body.replace(/^\n+|\n+$/g, "");
  if (!text.includes("\n")) {
    return (
      <GoInlineUnit>
        <InlineText text={text} />
      </GoInlineUnit>
    );
  }
  return (
    <span className={cn("block rounded-md px-md py-sm", GO_TINT)}>
      {text.split("\n").map((line, i) => {
        const picked = PICKED_RE.exec(line);
        return (
          <span key={i} className="block">
            {picked ? <PickedBox /> : null}
            <InlineText text={picked ? picked[1]! : line} />
          </span>
        );
      })}
    </span>
  );
}
