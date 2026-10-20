/**
 * Chord-grid loader: a text editor for chord symbols.
 *
 * Authors the grid (e.g. `Amaj9 Am9 (E E6)`). Fully **controlled** by the
 * shell's persisted `raw` — there is no local state, so switching the visible
 * source and back never loses what was typed. Every edit emits `{ text }` to the
 * shell, which compiles it. The field colours the parse's token spans in place;
 * typos are underlined there AND listed in a "Skipped" chip — never swallowed.
 * How chords become notes is the global voicing config's concern, not this
 * per-song editor's.
 */

import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import {
  FoldMotion,
  useCollapsible,
} from "@plugins/primitives/plugins/collapsible/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  DEFAULT_DRAFT_TTL,
  legacyDraftKeys,
  useDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import { OverlayTextarea } from "@plugins/primitives/plugins/syntax-highlight/plugins/overlay-textarea/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { Fragment, useMemo, type ReactNode } from "react";
import { asChordGridRaw, type ChordGridRaw } from "./compile";
import { parseGrid, type GridToken } from "./parse-grid";
import "./chord-grid.css";

const legendOpenStore = defineStore({
  owner: "sonata.chord-grid-legend",
  label: "Sonata layout preferences",
  area: "local",
  cap: "1 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "refuse",
  schema: z.boolean(),
  legacy: legacyDraftKeys("sonata:chord-grid:legend"),
});

const arrowDownIcon = symbol("keyboard-arrow-down");

interface Props {
  raw?: unknown;
  onRaw: (raw: unknown) => void;
}

const PLACEHOLDER = "; Verse\nAmaj9 Am9 (E E6) (E E6)\nCmaj7 Am7 Dm9 G13";

/** The syntax legend: each example beside what it means. */
const LEGEND: readonly (readonly [example: string, meaning: string])[] = [
  ["Am7 F C", "each chord is a bar"],
  ["(E E6)", "chords sharing one bar"],
  [".", "holds the previous chord"],
  ["; Verse", "comments the rest of the line"],
  ["I vi V7", "degrees of the key"],
  ["key: C", "sets the key"],
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The grid text cut along its token spans: each span a `data-tk` span (coloured
 * by chord-grid.css), the gaps between them plain. Every character of `text`
 * is emitted once, in order — the OverlayTextarea decorate contract.
 */
function decorateGrid(text: string, tokens: readonly GridToken[]) {
  const out: ReactNode[] = [];
  let at = 0;
  for (const t of tokens) {
    if (t.from > at) out.push(text.slice(at, t.from));
    out.push(
      <span key={t.from} data-tk={t.kind}>
        {text.slice(t.from, t.to)}
      </span>,
    );
    at = t.to;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function ChordGridLoader({ raw, onRaw }: Props) {
  const current = asChordGridRaw(raw);
  const { text } = current;

  const { events, skipped, tokens, bars } = useMemo(
    () => parseGrid(text),
    [text],
  );
  const [legendOpen, setLegendOpen] = useDraft(legendOpenStore, false);
  const legend = useCollapsible({
    open: legendOpen,
    onOpenChange: setLegendOpen,
  });

  const update = (patch: Partial<ChordGridRaw>) =>
    onRaw({ ...current, ...patch });

  return (
    <Stack gap="sm">
      <OverlayTextarea
        value={text}
        onChange={(next) => update({ text: next })}
        decorate={(value) => decorateGrid(value, tokens)}
        placeholder={PLACEHOLDER}
        ariaLabel="Chord grid"
        className="chord-grid-tokens rounded-md border border-border bg-background focus-within:border-primary"
      />

      <Cluster align="center" gap="xs">
        <Badge>{plural(events.length, "chord")}</Badge>
        <Badge>{plural(bars, "bar")}</Badge>
        {skipped.length > 0 ? (
          <Badge
            variant="destructive"
            role="alert"
            tooltip={`Skipped: ${skipped.join(", ")}`}
          >
            Skipped: {skipped.join(", ")}
          </Badge>
        ) : null}
        <Fill />
        <Button variant="ghost" {...legend.triggerControlProps}>
          Syntax
          <Icon
            icon={arrowDownIcon}
            className={cn("transition-transform", legend.open && "rotate-180")}
          />
        </Button>
      </Cluster>

      <FoldMotion {...legend.contentProps}>
        <dl className="chord-grid-legend text-caption">
          {LEGEND.map(([example, meaning]) => (
            <Fragment key={example}>
              <dt>
                <code>{example}</code>
              </dt>
              <dd>{meaning}</dd>
            </Fragment>
          ))}
        </dl>
      </FoldMotion>
    </Stack>
  );
}
