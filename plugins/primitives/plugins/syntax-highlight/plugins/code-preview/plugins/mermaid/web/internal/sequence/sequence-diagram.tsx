import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type {
  SequenceBlock,
  SequenceDiagram as SequenceModel,
  SequenceItem,
  SequenceMessage,
  SequenceNote,
  SequenceParticipant,
} from "../../../core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { participantHue } from "../hues";
import { actorIcon, iconFor, participantIcon } from "../icons";
import "./sequence.css";

/**
 * A sequence diagram drawn natively: one grid column per participant (its card
 * on top, its lifeline running behind), each message a coloured, numbered arrow
 * between two columns, notes as callouts, and loop / alt / … blocks as framed
 * sub-grids that keep the columns aligned through any nesting. Text is the
 * conversation's own size; a wide diagram scrolls rather than shrinks. Each
 * participant's badge is the icon its name reads as (icons.ts).
 */
export function SequenceDiagram({ diagram }: { diagram: SequenceModel }) {
  const index = useMemo(
    () => new Map(diagram.participants.map((p, i) => [p.id, i])),
    [diagram],
  );
  const steps = useMemo(() => numberMessages(diagram.items), [diagram]);
  const colMin = useMemo(() => columnMinWidth(diagram), [diagram]);
  // Hovering a participant or an item lights it (and a participant's own
  // messages) and fades the rest.
  const [hot, setHot] = useState<Hot>(null);

  const ctx: Ctx = {
    index,
    steps,
    hot,
    setHot,
    participants: diagram.participants,
  };
  const n = diagram.participants.length;
  return (
    <div
      className="mmd-seq"
      data-hovering={hot ? "" : undefined}
      style={{ "--mmd-n": n, "--mmd-col-min": `${colMin}px` } as CSSProperties}
    >
      <div className="mmd-seq-grid mmd-seq-lifelines" aria-hidden>
        {diagram.participants.map((p) => (
          <div key={p.id} />
        ))}
      </div>
      <div className="mmd-seq-grid">
        {diagram.participants.map((p, i) => (
          <ParticipantCard key={p.id} participant={p} hue={i} ctx={ctx} />
        ))}
      </div>
      <div className="mmd-seq-grid mmd-seq-body">
        {renderItems(diagram.items, 0, 0, ctx)}
      </div>
    </div>
  );
}

type Hot = { participant: string } | { item: SequenceItem } | null;

interface Ctx {
  index: Map<string, number>;
  steps: Map<SequenceMessage, number>;
  hot: Hot;
  setHot: (hot: Hot) => void;
  participants: readonly SequenceParticipant[];
}

function isHot(ctx: Ctx, item: SequenceMessage | SequenceNote): boolean {
  const { hot } = ctx;
  if (!hot) return false;
  if ("item" in hot) return hot.item === item;
  return item.kind === "message"
    ? item.from === hot.participant || item.to === hot.participant
    : item.over.includes(hot.participant);
}

function hueStyle(i: number): CSSProperties {
  return { "--mmd-hue": participantHue(i) } as CSSProperties;
}

function ParticipantCard({
  participant,
  hue,
  ctx,
}: {
  participant: SequenceParticipant;
  hue: number;
  ctx: Ctx;
}) {
  const { name, sub } = splitLabel(participant.label);
  return (
    <div
      className="mmd-seq-actor"
      style={hueStyle(hue)}
      onMouseEnter={() => ctx.setHot({ participant: participant.id })}
      onMouseLeave={() => ctx.setHot(null)}
    >
      <span className="mmd-badge mmd-seq-actor-badge" aria-hidden>
        <Icon
          icon={
            participant.kind === "actor"
              ? actorIcon
              : iconFor([name, sub], participantIcon)
          }
        />
      </span>
      <span className="mmd-seq-actor-text">
        <span className="mmd-seq-actor-name">{name}</span>
        {sub ? <span className="mmd-seq-actor-sub">{sub}</span> : null}
      </span>
    </div>
  );
}

/** `CLI (claude)` reads as a name over a subtitle: `CLI`, `claude`. */
function splitLabel(label: string): { name: string; sub: string | null } {
  const m = /^(.+?)\s*\((.+)\)$/.exec(label);
  return m ? { name: m[1]!, sub: m[2]! } : { name: label, sub: null };
}

/**
 * Items of one container (the body, or one block section), one per grid row.
 * `offset` is the container's first column: a block is a subgrid over only the
 * participants it touches, so its children's columns count from its own start.
 */
function renderItems(
  items: readonly SequenceItem[],
  offset: number,
  depth: number,
  ctx: Ctx,
): ReactNode[] {
  return items.map((item, row) => {
    const gridRow = row + 1;
    switch (item.kind) {
      case "message":
        return (
          <Message
            key={row}
            item={item}
            gridRow={gridRow}
            offset={offset}
            ctx={ctx}
          />
        );
      case "note":
        return (
          <Note
            key={row}
            item={item}
            gridRow={gridRow}
            offset={offset}
            ctx={ctx}
          />
        );
      case "block":
        return (
          <Block
            key={row}
            item={item}
            gridRow={gridRow}
            offset={offset}
            depth={depth}
            ctx={ctx}
          />
        );
    }
  });
}

function Message({
  item,
  gridRow,
  offset,
  ctx,
}: {
  item: SequenceMessage;
  gridRow: number;
  offset: number;
  ctx: Ctx;
}) {
  const a = ctx.index.get(item.from)!;
  const b = ctx.index.get(item.to)!;
  const self = a === b;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const span = hi - lo + 1;
  const dir = b >= a ? "right" : "left";
  const style: CSSProperties = {
    ...hueStyle(a),
    gridRow,
    gridColumn: `${lo - offset + 1} / ${hi - offset + 2}`,
    // From the first column's centre to the last's.
    ...(self ? {} : { marginInline: `calc(100% / ${2 * span})` }),
  };
  return (
    <div
      className="mmd-seq-msg"
      data-dir={dir}
      data-self={self ? "" : undefined}
      data-line={item.line}
      data-head={item.head}
      data-both={item.bidirectional ? "" : undefined}
      data-hot={isHot(ctx, item) ? "" : undefined}
      style={style}
      onMouseEnter={() => ctx.setHot({ item })}
      onMouseLeave={() => ctx.setHot(null)}
    >
      <div className="mmd-seq-msg-label">
        <span className="mmd-seq-step">{ctx.steps.get(item)}</span>
        {item.text !== "" ? (
          <span className="mmd-seq-msg-text">{item.text}</span>
        ) : null}
      </div>
      <div className="mmd-seq-msg-line" />
    </div>
  );
}

function Note({
  item,
  gridRow,
  offset,
  ctx,
}: {
  item: SequenceNote;
  gridRow: number;
  offset: number;
  ctx: Ctx;
}) {
  const cols = item.over.map((id) => ctx.index.get(id)!);
  const lo = Math.min(...cols);
  const hi = Math.max(...cols);
  return (
    <div
      className="mmd-seq-note-cell"
      data-placement={item.placement}
      data-wide={hi > lo ? "" : undefined}
      style={{
        gridRow,
        gridColumn: `${lo - offset + 1} / ${hi - offset + 2}`,
        ...(hi > lo
          ? { paddingInline: `calc(100% / ${2 * (hi - lo + 1)} - 1.5rem)` }
          : {}),
      }}
    >
      <div
        className="mmd-seq-note"
        style={hueStyle(lo)}
        data-hot={isHot(ctx, item) ? "" : undefined}
        onMouseEnter={() => ctx.setHot({ item })}
        onMouseLeave={() => ctx.setHot(null)}
      >
        {item.text}
      </div>
    </div>
  );
}

function Block({
  item,
  gridRow,
  offset,
  depth,
  ctx,
}: {
  item: SequenceBlock;
  gridRow: number;
  offset: number;
  depth: number;
  ctx: Ctx;
}) {
  const cols = touched(item).map((id) => ctx.index.get(id)!);
  // A block with nothing in it still frames the whole width.
  const lo = cols.length ? Math.min(...cols) : 0;
  const hi = cols.length ? Math.max(...cols) : ctx.participants.length - 1;
  return (
    <div
      className="mmd-seq-block"
      data-type={item.type}
      style={
        {
          gridRow,
          gridColumn: `${lo - offset + 1} / ${hi - offset + 2}`,
          "--mmd-depth": depth,
        } as CSSProperties
      }
    >
      {item.sections.map((section, i) => (
        <div
          key={i}
          className="mmd-seq-section"
          data-first={i === 0 ? "" : undefined}
          style={{ gridRow: i + 1 }}
        >
          <div className="mmd-seq-section-head">
            {i === 0 ? (
              <span className="mmd-seq-block-tag">{item.type}</span>
            ) : null}
            {section.label !== "" ? (
              <span className="mmd-seq-section-label">
                {i === 0 ? section.label : `[${section.label}]`}
              </span>
            ) : null}
          </div>
          <div className="mmd-seq-section-body">
            {renderItems(section.items, lo, depth + 1, ctx)}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Every participant a block's contents name, in any nesting. */
function touched(block: SequenceBlock): string[] {
  const out = new Set<string>();
  const visit = (items: readonly SequenceItem[]) => {
    for (const it of items) {
      if (it.kind === "message") {
        out.add(it.from);
        out.add(it.to);
      } else if (it.kind === "note") {
        it.over.forEach((id) => out.add(id));
      } else {
        it.sections.forEach((s) => visit(s.items));
      }
    }
  };
  block.sections.forEach((s) => visit(s.items));
  return [...out];
}

function numberMessages(
  items: readonly SequenceItem[],
): Map<SequenceMessage, number> {
  const out = new Map<SequenceMessage, number>();
  const visit = (list: readonly SequenceItem[]) => {
    for (const it of list) {
      if (it.kind === "message") out.set(it, out.size + 1);
      else if (it.kind === "block") it.sections.forEach((s) => visit(s.items));
    }
  };
  visit(items);
  return out;
}

// Approximate advance of one character of the label fonts, in px — enough to
// size columns so a label rarely outgrows the hop it names.
const MONO_CHAR = 7.6;
const SANS_CHAR = 7.4;
const CAPTION_CHAR = 6.4;

/**
 * The narrowest a column may be: wide enough for every participant card, and
 * for each message label shared out over the columns it spans. Beyond that the
 * columns share the width; past the container, the diagram scrolls.
 */
function columnMinWidth(diagram: SequenceModel): number {
  let min = 140;
  for (const p of diagram.participants) {
    // The card stacks the name over its subtitle: the wider of the two.
    const { name, sub } = splitLabel(p.label);
    const text = Math.max(
      name.length * SANS_CHAR,
      (sub?.length ?? 0) * CAPTION_CHAR,
    );
    min = Math.max(min, text + 80);
  }
  const index = new Map(diagram.participants.map((p, i) => [p.id, i]));
  const visit = (items: readonly SequenceItem[]) => {
    for (const it of items) {
      if (it.kind === "message") {
        const longest = Math.max(...it.text.split("\n").map((l) => l.length));
        const span = Math.abs(index.get(it.from)! - index.get(it.to)!) + 1;
        const px = longest * MONO_CHAR + 56;
        min = Math.max(min, span === 1 ? px : px / span + 24);
      } else if (it.kind === "block") {
        it.sections.forEach((s) => visit(s.items));
      }
    }
  };
  visit(diagram.items);
  return Math.round(Math.min(min, 360));
}
