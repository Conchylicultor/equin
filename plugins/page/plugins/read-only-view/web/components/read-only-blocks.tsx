import type { ComponentType, CSSProperties, ReactNode } from "react";

import { isEmoji } from "@plugins/ui/plugins/icons/plugins/emoji/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import {
  Text,
  type TextVariant,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Inset,
  insetClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { CheckboxIndicator } from "@plugins/primitives/plugins/css/plugins/selection-indicator/web";
import { HighlightedCode } from "@plugins/primitives/plugins/syntax-highlight/web";
import { attachmentUrl } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import {
  ImageGallery,
  MissingImage,
  useImageLoad,
  useImageViewerTrigger,
} from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import {
  Editor,
  PageIcon,
  TextBlockLayout,
  useBlockDecorations,
  useBlockFeet,
  FrameHoverProvider,
  useIsFramedBlock,
  BLOCK_INDENT,
  BLOCK_INSET,
  FRAME_PAD_X,
  FRAME_PAD_Y,
  useFrameGeometry,
  type FrameCandidate,
  type FrameGeometry,
  type BlockDecoration,
  type BlockFootProps,
} from "@plugins/page/plugins/editor/web";
import { PAGE_BLOCK_TYPE } from "@plugins/page/plugins/editor/core";
import type {
  BlockHandle,
  BlockTextVariant,
} from "@plugins/page/plugins/editor/core";
import { RunsRenderer } from "./runs-renderer";
import { PlaceholderCard } from "./placeholder-card";
import type { BlockDiffKind, ReadOnlyNode } from "../node";
import { symbol } from "@plugins/ui/plugins/icons/core";

const imageIcon = symbol("image");
const linkIcon = symbol("link");
const functionsIcon = symbol("functions");
const bookmarkIcon = symbol("bookmark");
const musicNoteIcon = symbol("music-note");
const videocamIcon = symbol("videocam");
const draftIcon = symbol("draft");
const widgetsIcon = symbol("widgets");

/**
 * `BlockTextVariant` is a superset of `TextVariant` only in name; the values are
 * identical strings. The cast is safe and keeps the mapping a no-op rather than a
 * hand-written switch.
 */
function asTextVariant(v: BlockTextVariant | undefined): TextVariant {
  return (v ?? "body") as TextVariant;
}

/**
 * One `Editor.Block` contribution as the slot's READ hook hands it over: its
 * `component` is sealed (wrapped in the framework's middleware chain), so this
 * is derived from the hook rather than named as the editor's own
 * `BlockContribution` — which types what a plugin WRITES.
 */
type BlockEntry = ReturnType<typeof Editor.Block.useContributions>[number];

/** A record-view of a block's `data`. */
function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// Diff styling — semantic tokens only.
// ---------------------------------------------------------------------------

/**
 * Subtle, tasteful per-block diff treatment built from semantic tokens (no raw
 * colors): a left accent rail + faint tint, matching the version-history plan.
 *  - added    → success-tinted rail + bg
 *  - removed  → muted rail + faded, struck-through (still rendered inline)
 *  - modified → primary accent rail
 */
const DIFF_CLASS: Record<BlockDiffKind, string> = {
  added: "border-l-2 border-success bg-success/10",
  removed:
    "border-l-2 border-muted-foreground/40 bg-muted/40 opacity-60 line-through",
  modified: "border-l-2 border-primary bg-primary/5",
};

function DiffWrap({
  kind,
  children,
}: {
  kind?: BlockDiffKind;
  children: ReactNode;
}) {
  if (!kind) return <>{children}</>;
  return <div className={cn("rounded-sm", DIFF_CLASS[kind])}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Block content renderers
// ---------------------------------------------------------------------------

/**
 * Renders one text-bearing block faithfully (text, headings, lists, to-do,
 * toggle, quote, prompt): the SAME `TextBlockLayout` skeleton the editable
 * surface uses, styled by the SAME per-type `chrome` off the block's
 * `Editor.Block` contribution — only the leaf differs (`RunsRenderer` instead of
 * the Lexical editor). It therefore names zero block types: the quote's border
 * and the prompt's raised box arrive as chrome, not as a branch here.
 *
 * The region props carry `pageId: null` (a snapshot is detached from any page),
 * `isFocused: false`, and — load-bearing — **no `editor`**: that absence IS the
 * read-only signal, and a region is expected to degrade to a static rendering or
 * render nothing rather than paint a control whose click no-ops.
 */
function TextLikeBlock({
  node,
  contribution,
  data,
  ordinal,
}: {
  node: ReadOnlyNode;
  contribution: BlockEntry;
  data: Record<string, unknown>;
  /** 1-based position among same-type siblings (for ordinal markers). */
  ordinal: number;
}) {
  const handle = contribution.block;
  const checked = handle.toggle ? Boolean(data[handle.toggle.field]) : false;

  let fallbackMarker: ReactNode = null;
  if (handle.toggle) {
    // Seat the checkbox on the first text line: the gutter shares the text's
    // top `py-xs`, so the indicator top-aligns without a raw margin offset.
    fallbackMarker = (
      <span className="py-xs">
        <CheckboxIndicator checked={checked} />
      </span>
    );
  } else if (handle.ordinalMarker) {
    fallbackMarker = (
      <Text
        as="span"
        variant="body"
        tone="muted"
        aria-hidden
        className="tabular-nums py-xs"
      >
        {handle.ordinalMarker(ordinal)}
      </Text>
    );
  } else if (handle.marker) {
    fallbackMarker = (
      <Text as="span" variant="body" tone="muted" aria-hidden className="py-xs">
        {handle.marker}
      </Text>
    );
  }

  const doneClass =
    handle.toggle && checked
      ? (handle.toggle.doneClassName ?? "line-through text-muted-foreground")
      : undefined;

  return (
    <TextBlockLayout
      chrome={contribution.chrome}
      semantics={handle.semantics}
      region={{
        // A read-only node may legitimately carry no id at all.
        id: node.id ?? "",
        type: node.type,
        pageId: null,
        data: node.data,
        isFocused: false,
        ordinal,
      }}
      fallbackMarker={fallbackMarker}
    >
      <Text
        as="div"
        variant={asTextVariant(handle.textVariant)}
        className={cn(
          insetClass({ r: BLOCK_INSET }),
          "py-xs whitespace-pre-wrap break-words",
          doneClass,
        )}
      >
        <RunsRenderer value={data.text} />
      </Text>
    </TextBlockLayout>
  );
}

/** Faithful media / structural blocks that don't need the editor API. */
function MediaBlock({
  type,
  data,
}: {
  type: string;
  data: Record<string, unknown>;
}): ReactNode {
  if (type === "divider") {
    return (
      <Inset x={BLOCK_INSET} y="sm">
        <hr className="border-border border-t" />
      </Inset>
    );
  }

  if (type === "code-block") {
    const code = typeof data.code === "string" ? data.code : "";
    const lang = typeof data.language === "string" ? data.language : null;
    return (
      <Inset x={BLOCK_INSET} y="xs">
        <HighlightedCode code={code} lang={lang} />
      </Inset>
    );
  }

  if (type === "image") {
    const attachmentId =
      typeof data.attachmentId === "string" ? data.attachmentId : null;
    const alt = typeof data.alt === "string" ? data.alt : "";
    const width = typeof data.width === "number" ? data.width : undefined;
    if (!attachmentId) {
      return (
        <PlaceholderCard label="Image" icon={imageIcon} caption="No image" />
      );
    }
    return (
      // The image keeps its own <img> (it honours the stored width), so it
      // renders the gallery its viewer trigger needs: a gallery of one.
      <ImageGallery>
        <ReadOnlyImage attachmentId={attachmentId} alt={alt} width={width} />
      </ImageGallery>
    );
  }

  return null;
}

/**
 * A filled image block: a click opens the full-window viewer, as on the
 * editable surface, and a file that no longer loads shows the missing-image box
 * at its own size rather than the browser's broken-image glyph.
 */
function ReadOnlyImage({
  attachmentId,
  alt,
  width,
}: {
  attachmentId: string;
  alt: string;
  width: number | undefined;
}) {
  const src = attachmentUrl(attachmentId);
  const name = alt || "Image";
  const viewerTrigger = useImageViewerTrigger<HTMLImageElement>({
    src,
    name,
    alt: alt || undefined,
  });
  const { load, imgKey, imgProps, retry } = useImageLoad(src);
  if (load.kind === "failed") {
    return (
      <Inset x={BLOCK_INSET} y="xs">
        <MissingImage name={name} reason={load.reason} onRetry={retry} />
      </Inset>
    );
  }
  const style: CSSProperties = {
    width: width ? `${width}px` : undefined,
    maxWidth: "100%",
  };
  return (
    <Inset x={BLOCK_INSET} y="xs">
      <div className="inline-block max-w-full" style={style}>
        {/* `rounded-md` matches the editor's image chrome. */}
        <img
          key={imgKey}
          src={src}
          alt={alt}
          {...viewerTrigger}
          {...imgProps}
          className="block w-full cursor-zoom-in rounded-md"
        />
      </div>
    </Inset>
  );
}

/**
 * A sub-page rendered inert: icon + title, no navigation. Sub-pages are members
 * of a page's content forest (one ordering space), so a read-only render — the
 * public blog site, a version-history preview — sees them and must show
 * something honest rather than an "Unknown block: page" placeholder card. The
 * chip is deliberately not a link: a read-only surface has no page router, and
 * the target may not even be published.
 */
function SubPageChip({ data }: { data: Record<string, unknown> }) {
  const icon =
    typeof data.icon === "string" && isEmoji(data.icon) ? data.icon : null;
  const title =
    typeof data.title === "string" && data.title ? data.title : "Untitled";
  return (
    <Inset x="md" y="xs">
      <Inline gap="xs">
        <PageIcon icon={icon} className="text-muted-foreground size-4" />
        <Text className="font-medium">{title}</Text>
      </Inline>
    </Inset>
  );
}

/** Exotic blocks → labeled placeholder card (documented fidelity gap). */
const PLACEHOLDER_ICONS: Record<string, typeof widgetsIcon> = {
  embed: linkIcon,
  equation: functionsIcon,
  bookmark: bookmarkIcon,
  audio: musicNoteIcon,
  video: videocamIcon,
  file: draftIcon,
  "page-link": linkIcon,
};

function captionFor(
  type: string,
  data: Record<string, unknown>,
): string | undefined {
  if (typeof data.filename === "string") return data.filename;
  if (type === "embed" && typeof data.url === "string") return data.url;
  if (type === "bookmark" && typeof data.title === "string") return data.title;
  if (type === "equation" && typeof data.expression === "string")
    return data.expression;
  return undefined;
}

const MEDIA_TYPES = new Set(["divider", "code-block", "image"]);

/** Blocks the shared text layout can faithfully reproduce. */
function isTextLike(c: BlockEntry | undefined): c is BlockEntry {
  // Any block whose data carries `text` is text-bearing. The contribution's
  // handle metadata (marker/ordinalMarker/toggle/textVariant) and its `chrome`
  // are what we render from.
  return c !== undefined;
}

// ---------------------------------------------------------------------------
// Forest renderer
// ---------------------------------------------------------------------------

export interface ReadOnlyBlocksProps {
  /**
   * The block forest to render. A plain `SerializedBlock[]` is assignable here
   * (the extra `id` is optional); pass ids when diff highlighting is wanted.
   */
  forest: ReadOnlyNode[];
  /** Optional per-block diff tags, keyed by `ReadOnlyNode.id`. */
  diff?: Map<string, BlockDiffKind>;
}

/** Whether a block's `data` carries a rich-text `text` field. */
function hasText(data: Record<string, unknown>): boolean {
  return "text" in data;
}

/**
 * Renders whichever FOOT the container's frame registration supplied — the strip
 * of the card's own chrome at the bottom of its box.
 *
 * It takes the component as a PROP, the same shape `AnchorDecoration` uses on the
 * editable surface, because a component ARRIVING as a prop is not a component
 * created during render — where a local binding off a registry lookup reads as
 * one. `Foot` is a lookup into the memoized `useBlockFeet()` map, whose values
 * are module-level slot contributions, so its identity is stable across renders.
 * (The decoration above says the same thing with a member expression,
 * `decoration.component`, because its map stores a seat beside the component.)
 *
 * No `editor` prop: that absence is this surface's read-only signal.
 */
function ContainerFoot({
  component: Foot,
  node,
}: {
  component: ComponentType<BlockFootProps>;
  node: ReadOnlyNode;
}) {
  return <Foot type={node.type} data={node.data} blockId={node.id} />;
}

function NodeView({
  node,
  ordinal,
  contributions,
  isFramed,
  frameGeometry,
  decorations,
  feet,
  diff,
}: {
  node: ReadOnlyNode;
  ordinal: number;
  /**
   * The live `Editor.Block` contributions — kept whole rather than mapped down
   * to handles, because a text-bearing type's presentation (`chrome`) rides on
   * the contribution, not the handle.
   */
  contributions: readonly BlockEntry[];
  /** Whether a block is a container, from the live `Editor.BlockFrame` registry. */
  isFramed: (block: FrameCandidate) => boolean;
  /**
   * Per container type: whether its box holds its content off its edges, and
   * whether it reclaims its children's indent step to pay for that. From the
   * same registry, so it cannot drift from who actually paints a fill.
   */
  frameGeometry: ReadonlyMap<string, FrameGeometry>;
  /** Container-anchor decorations, from the same `Editor.BlockFrame` registry. */
  decorations: ReadonlyMap<string, BlockDecoration>;
  /** Container FEET, from that same registry — the strip at a card's bottom. */
  feet: ReadonlyMap<string, ComponentType<BlockFootProps>>;
  diff?: Map<string, BlockDiffKind>;
}) {
  const contribution = contributions.find((c) => c.block.type === node.type);
  const handle: BlockHandle<unknown> | undefined = contribution?.block;
  const data = asRecord(node.data);
  const kind = node.id ? diff?.get(node.id) : undefined;

  // What this node's CONTENT reserves so it clears the box painted behind it.
  //
  // The editor hands the same reserve to its grid rows; here nesting is a real
  // wrapper, so the wrapper carries it — one pad per side, but only for a
  // `pad: "box"` container. A quote's bar has no edge to clear, so it reserves
  // nothing and its passage keeps the full column.
  //
  const framed = isFramed({
    type: node.type,
    data: node.data,
    expanded: node.expanded,
  });
  const geometry = framed ? frameGeometry.get(node.type) : undefined;
  const framePad: CSSProperties = geometry?.pads
    ? {
        paddingRight: FRAME_PAD_X,
        paddingTop: `var(--space-${FRAME_PAD_Y})`,
        paddingBottom: `var(--space-${FRAME_PAD_Y})`,
      }
    : {};

  // The LEFT pad is the child indent SPENT as padding, so a container that
  // ABSORBS that step indents its children by the pad instead of by the full
  // `BLOCK_INDENT` — exactly what `blockContentLeft` does on the editable
  // surface. One that does not (its gutter glyph stands in the column) keeps the
  // full step, and so does every ordinary block.
  const childIndent = geometry?.absorbs ? FRAME_PAD_X : BLOCK_INDENT;

  // Children always render expanded (read-only). Each child list restarts its
  // own ordinal counter, reset on type change (matches the editor's numbering).
  const children =
    node.children.length > 0 ? (
      // One depth of indent: the child forest's content box starts that far
      // right of this block's — `BLOCK_INDENT` normally, and the card's own pad
      // when this node is a container that absorbed the step.
      <div style={{ paddingLeft: childIndent, ...framePad }}>
        <ForestView
          forest={node.children}
          contributions={contributions}
          isFramed={isFramed}
          frameGeometry={frameGeometry}
          decorations={decorations}
          feet={feet}
          diff={diff}
        />
      </div>
    ) : null;

  let body: ReactNode;
  if (node.type === PAGE_BLOCK_TYPE) {
    // Must precede the generic fallback: a sub-page's handle carries no `label`
    // and its data has no `text`, so it would otherwise land on the placeholder
    // card and leak "Unknown block: page" onto every read-only surface.
    body = (
      <>
        <SubPageChip data={data} />
        {children}
      </>
    );
  } else if (MEDIA_TYPES.has(node.type)) {
    body = (
      <>
        <MediaBlock type={node.type} data={data} />
        {children}
      </>
    );
  } else if (handle?.anchor === true) {
    // A container ANCHOR (the callout) renders NO line of its own: its content IS
    // its children, and all it paints is a decoration in the indent gutter left
    // of the first child. Must precede the text-like arm — an anchor's `data`
    // carries no `text`, so it would otherwise land on the "Unknown block"
    // placeholder card, exactly the trap `PAGE_BLOCK_TYPE` above documents.
    //
    // Generic, by design: this branch names no block type. The decoration comes
    // from the same `Editor.BlockFrame` registration that paints the box, so a
    // second container type needs zero changes here.
    //
    // The geometry falls out on this surface. There is no hover rail (`inset: 0`)
    // and children are already indented by one `BLOCK_INDENT`, so a zero-height
    // `relative` wrapper with the decoration pinned at its left edge puts the
    // glyph in exactly the column the editor puts it in — with none of the
    // control-collision the editable surface has to resolve.
    const decoration = decorations.get(node.type);
    const foot = feet.get(node.type);
    body = (
      <>
        {/* Zero height: an absolutely-pinned child contributes none, so the
            decoration and the first child share one visual line. The CORNER seat
            pins to the other end of that same line, over the content, where the
            editor pins it to the frame box's top-right.

            Appearance and nothing else, in both seats. A decoration's structural
            actions live on the rail of the line the container borrows, which this
            surface has none of — and it carries no id here either, since a
            read-only node may legitimately have none. Omitting `editor` is the
            read-only signal: the contribution degrades to a static mark rather
            than rendering a dead control. */}
        <div className="relative">
          {decoration ? (
            <Pin
              to={decoration.seat === "corner" ? "top-right" : "top-left"}
              className="py-xs"
              style={
                decoration.seat === "corner"
                  ? undefined
                  : { width: BLOCK_INDENT }
              }
            >
              {/* Not a component CREATED during render: this is a registry
                  LOOKUP into the memoized `useBlockDecorations()` map, whose
                  values are module-level slot contributions. */}
              <decoration.component type={node.type} data={node.data} />
            </Pin>
          ) : null}
        </div>
        {children ?? (
          // Read-only children always render expanded, so `children` is null only
          // when the container is genuinely childless — and then both the row and
          // its frame would be zero height, i.e. an invisible box. One empty body
          // line is the same fallback the editor's anchored row renders. The
          // space below is a NON-BREAKING one: a lone collapsible space would
          // leave the div zero height, which is the very thing this fixes.
          <div style={{ paddingLeft: childIndent, ...framePad }}>
            <Inset l={BLOCK_INSET}>
              <Text as="div" variant="body" className="py-xs">
                {" "}
              </Text>
            </Inset>
          </div>
        )}
        {/* The container's FOOT: its own chrome at the bottom of the box, below
            the last child and inside the card's padding. It lines up with the
            card's CHILDREN (`childIndent`), not with the box's edge, and clears
            the box's right and bottom exactly as the children wrapper does — so
            the wrapper's own `padding-bottom` becomes the gap between the card's
            last line and its foot, which is what the editable surface reserves
            explicitly. Nesting is a real wrapper here rather than a shared grid,
            so there is no closing-slot arithmetic to do: each card's pads are
            already spent inside its own wrapper.

            NO `editor` prop — that absence IS the read-only signal, the same one
            the decoration above degrades on. A foot whose content is LIVE state
            (the runs a card has launched) renders nothing here, correctly: a
            version-history preview of last Tuesday must not show today's runs. */}
        {foot ? (
          <div
            style={{
              paddingLeft: childIndent,
              paddingRight: framePad.paddingRight,
              paddingBottom: framePad.paddingBottom,
            }}
          >
            <ContainerFoot component={foot} node={node} />
          </div>
        ) : null}
      </>
    );
  } else if (contribution?.view) {
    // A text-less type that declared its own STATIC rendering on its
    // `Editor.Block` registration (the table). Generic: this arm names no block
    // type, and the view arrives already bound to the handle's `parse`, so it
    // is handed the stored `data` untouched. Must precede the text-like arm for
    // the same reason the anchor arm does — the data carries no `text`, so the
    // type would otherwise land on the placeholder card.
    body = (
      <>
        <contribution.view data={node.data} />
        {children}
      </>
    );
  } else if (isTextLike(contribution) && hasText(data)) {
    body = (
      <>
        <TextLikeBlock
          node={node}
          contribution={contribution}
          data={data}
          ordinal={ordinal}
        />
        {children}
      </>
    );
  } else {
    // Exotic / editor-API-only block → labeled placeholder card.
    const label = handle?.label ?? node.type;
    body = (
      <>
        <PlaceholderCard
          label={label}
          caption={captionFor(node.type, data)}
          icon={PLACEHOLDER_ICONS[node.type] ?? widgetsIcon}
        />
        {children}
      </>
    );
  }

  // A container block type paints a frame over its own line AND its subtree.
  // The frame takes no children (it is a backdrop, never a wrapper — see
  // `BlockFrameProps`), so this surface positions it as a full-bleed layer
  // behind the node's content. `inset` is 0: there is no hover rail here, so
  // the content edge `C` is simply the renderer's left edge.
  //
  // `blockId` is passed through as-is and is `undefined` whenever the node is a
  // detached snapshot (a version-history preview, the public site) — that is the
  // documented degradation, not a gap: a frame reading a side table keyed by
  // block id falls back to its static appearance there.
  const withFrame = framed ? (
    // `group/frame` is this surface's half of the corner decoration's reveal:
    // here the frame and the lines it covers DO share an ancestor (nesting is a
    // real wrapper div, not a grid span), so a card's name can appear on plain
    // CSS hover with no pointer tracking at all. The editor, whose frame is a
    // grid sibling, has to answer the same question with a store.
    <Overlay
      className="group/frame"
      behind={
        <Editor.BlockFrame.Dispatch
          type={node.type}
          data={node.data}
          blockId={node.id}
          inset={0}
          // No rail, and nesting is a real WRAPPER here rather than a shared
          // grid: an enclosing card's pad is already spent inside this node's own
          // wrapper, so this frame has no nesting share left to pull in by. Its
          // content's clearance comes from `framePad` above, not from here.
          //
          // The right edge still mirrors the left, which `frameBoxLeft` puts one
          // `BLOCK_INSET` in — so the box spans exactly the prose column, the
          // same claim the editable surface makes.
          rightInset={`var(--space-${BLOCK_INSET})`}
          topInset="0px"
          bottomInset="0px"
        />
      }
    >
      {body}
    </Overlay>
  ) : (
    body
  );

  return <DiffWrap kind={kind}>{withFrame}</DiffWrap>;
}

function ForestView({
  forest,
  contributions,
  isFramed,
  frameGeometry,
  decorations,
  feet,
  diff,
}: {
  forest: ReadOnlyNode[];
  contributions: readonly BlockEntry[];
  isFramed: (block: FrameCandidate) => boolean;
  frameGeometry: ReadonlyMap<string, FrameGeometry>;
  decorations: ReadonlyMap<string, BlockDecoration>;
  feet: ReadonlyMap<string, ComponentType<BlockFootProps>>;
  diff?: Map<string, BlockDiffKind>;
}) {
  const ordinals: number[] = [];
  let prev: string | null = null;
  let n = 0;
  for (const node of forest) {
    n = node.type === prev ? n + 1 : 1;
    prev = node.type;
    ordinals.push(n);
  }
  return (
    <>
      {forest.map((node, i) => (
        <NodeView
          key={node.id ?? i}
          node={node}
          ordinal={ordinals[i] ?? 1}
          contributions={contributions}
          isFramed={isFramed}
          frameGeometry={frameGeometry}
          decorations={decorations}
          feet={feet}
          diff={diff}
        />
      ))}
    </>
  );
}

/**
 * Faithful, non-editable renderer for a block forest, with optional per-block
 * diff highlighting. Dispatches on `block.type` using the live `Editor.Block`
 * handle metadata (no Lexical, no editor providers).
 *
 * Fidelity:
 *  - Text-bearing blocks (text, heading-1/2/3, bulleted/numbered list, to-do,
 *    toggle, quote) render fully faithfully — heading size, marker, checkbox,
 *    rich text.
 *  - Container blocks render through the SAME `Editor.BlockFrame` contribution
 *    the editor uses: the box as a full-bleed backdrop, and — for a void
 *    container ANCHOR (the callout) — its decoration pinned in the gutter left of
 *    its first child. No block type is named here.
 *  - Self-contained media (image, code-block, divider) render a faithful static
 *    equivalent, and sub-pages render as an inert icon+title chip.
 *  - A text-less type that registers a `view` (the table) renders through it —
 *    the block's own static rendering, dispatched without naming the type.
 *  - Exotic blocks (embed, equation, bookmark, audio, video, file) render a clean
 *    labeled placeholder card — the documented fidelity gap.
 */
export function ReadOnlyBlocks({ forest, diff }: ReadOnlyBlocksProps) {
  // The contributions are kept WHOLE (not mapped down to handles): a
  // text-bearing type's presentation — the quote's border, the prompt's raised
  // box and its regions — lives on the contribution's `chrome`, and this surface
  // renders it through the same `TextBlockLayout` the editor uses.
  const contributions = Editor.Block.useContributions();
  const isFramed = useIsFramedBlock();
  const frameGeometry = useFrameGeometry();
  const decorations = useBlockDecorations();
  const feet = useBlockFeet();
  return (
    // A corner decoration asks the editor's hover store whether the pointer is
    // inside its card. This surface never writes to it — it reveals by the CSS
    // group above, which it can, having real wrapper elements — but the question
    // must have somewhere to land, so the provider is mounted and always answers
    // "no". One decoration component, two surfaces, no second code path.
    <FrameHoverProvider>
      <ForestView
        forest={forest}
        contributions={contributions}
        isFramed={isFramed}
        frameGeometry={frameGeometry}
        decorations={decorations}
        feet={feet}
        diff={diff}
      />
    </FrameHoverProvider>
  );
}
