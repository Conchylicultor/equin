import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Text,
  type TextVariant,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { landingPane } from "../panes";

/**
 * The brand wordmark in the shared site header's leading zone. Always navigates
 * home (the landing pane) — the one nav entry the shell owns itself.
 *
 * It is the `inline` aspect of a button — the text IS the control, with no
 * padded box around it — so the wordmark starts on the header's left edge, the
 * same edge every band below starts on. A padded button would indent it.
 *
 * Its hover dims the whole mark a step (opacity), with no hover box. A fill
 * hugging unpadded type reads as a smudge, and the nav links' own affordance —
 * grey coming up to full foreground — has nowhere to go here: the wordmark
 * already IS the foreground. Opacity rather than a colour so it needs no token:
 * it reads the same on the dark page, the light one, and every backdrop a page
 * dresses the header for (the Foundations iceberg's sky and water).
 *
 * The full stop is the mark: it is the only place on the site where the brand
 * colour appears as identity rather than as an affordance, which is what lets
 * every other accent (a link, a button, the hero's gradient) read as something
 * you can act on.
 */
export function WebsiteWordmark() {
  const openPane = useOpenPane();
  return (
    <Button
      variant="ghost"
      aspect="inline"
      className="hover:bg-transparent hover:opacity-70"
      {...openPane.link(landingPane, {}, { mode: "root" })}
    >
      <WordmarkText />
    </Button>
  );
}

/**
 * The wordmark as plain type — no navigation. The header's version is a button
 * that goes home, set at the heading size; the footer's is the signature at the
 * end of the document, smaller and greyer, where there is nowhere left to go.
 */
export function WordmarkText({
  variant = "heading",
  className,
}: {
  variant?: TextVariant;
  className?: string;
}) {
  return (
    <Text
      variant={variant}
      className={cn("font-bold tracking-tight", className)}
    >
      equin
      {/* A plain run, not a nested `<Text>`: in the header's single-line
          context a `<Text>` becomes its own clipped, block-level box, so the
          full stop would drop onto a line of its own. (It used to be an
          inline-block, which kept it on the line but sat it on the box's bottom
          edge rather than the text's baseline, lifting the stop — the same
          overflow-baseline rule, seen from the other side.) */}
      <span className="text-primary-text">.</span>
    </Text>
  );
}
