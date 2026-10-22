import { createContext, useContext, useState } from "react";
import {
  EmojiPicker as Frimousse,
  defaultEmojiDataResolver,
  type EmojiData,
  type EmojiDataResolver,
  type EmojiPickerListCategoryHeaderProps,
  type EmojiPickerListEmojiProps,
  type EmojiPickerListRowProps,
} from "frimousse";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { assetMirrorUrl } from "@plugins/infra/plugins/asset-mirror/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { SectionLabel } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { EmojiSchema, type Emoji } from "../../core";
import { EmojiGlyph } from "./emoji-glyph";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import { unavailableMessage } from "@plugins/infra/plugins/endpoints/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { EMOJIBASE_LOCALE, EMOJIBASE_MIRROR_ID } from "../../shared/mirror";

/** Today's grid: nine columns. A caller may ask for another count. */
const DEFAULT_COLUMNS = 9;

/**
 * The newest Unicode emoji version the picker offers. Every picked emoji is
 * re-validated by {@link EmojiSchema} — in the browser here and again by the
 * server's own copy of the schema — whose `\p{RGI_Emoji}` table is the engine's
 * Unicode data. Capping below the newest emojibase release keeps the picker from
 * offering an emoji one runtime draws and the other's schema cannot recognise.
 */
const EMOJI_VERSION = 15.1;

const EMOJIBASE_URL = assetMirrorUrl(EMOJIBASE_MIRROR_ID);

/** The picker's current value, read by the (module-level, identity-stable) cell renderer. */
const SelectedEmoji = createContext<Emoji | null>(null);

/**
 * How the picker is drawn:
 *
 * - `compact` (default) — its own "Emoji" eyebrow, a small search field, 28px
 *   cells with a 20px glyph and tiny category labels, in a 256px scroll;
 * - `panel` — drawn as one more panel of a control-panel menu: no label of its
 *   own (the panel's search field leads), a search field one panel row tall,
 *   category heads on the `group` role, cells that fill their column 32px tall
 *   with a ~19px glyph, the selection in the accent's soft fill and line, in a
 *   236px scroll.
 */
export type EmojiPickerVariant = "compact" | "panel";

/** Read by the module-level row / cell / header renderers, like `SelectedEmoji`. */
const Variant = createContext<EmojiPickerVariant>("compact");

const CATEGORY_HEADER: Record<EmojiPickerVariant, string> = {
  // A category label's offset above its first emoji row.
  compact: "bg-popover pb-1 pt-2 text-3xs text-muted-foreground/60",
  // A group head, on the panel's group role, a hair in from the cells' edge.
  panel: "bg-popover px-2xs pb-xs pt-sm text-group text-group-foreground",
};

function CategoryHeader({
  category,
  ...props
}: EmojiPickerListCategoryHeaderProps) {
  const variant = useContext(Variant);
  return (
    <div
      {...props}
      // eslint-disable-next-line spacing/no-adhoc-spacing -- the compact header's pb-1/pt-2: a category label's offset above its first emoji row
      className={CATEGORY_HEADER[variant]}
    >
      {category.label}
    </div>
  );
}

function EmojiRow({ children, ...props }: EmojiPickerListRowProps) {
  const variant = useContext(Variant);
  // frimousse sets the row's display:flex itself; this only spaces its cells.
  return (
    <div
      {...props}
      className={variant === "panel" ? "gap-px pb-px" : "gap-xs pb-xs"}
    >
      {children}
    </div>
  );
}

function EmojiCell({ emoji, ...props }: EmojiPickerListEmojiProps) {
  const selected = useContext(SelectedEmoji) === emoji.emoji;
  const variant = useContext(Variant);
  if (variant === "panel") {
    return (
      <button
        {...props}
        aria-pressed={selected}
        // Each cell takes an equal share of the row (frimousse lays a row out
        // as a flex line), so the columns span the panel.
        className={cn(
          fillClasses("x"),
          "h-8 rounded-md hover:bg-hover-fill data-[active]:bg-hover-fill",
          selected && "bg-primary/10 ring-1 ring-primary/35 ring-inset",
        )}
      >
        <Center>
          {/* A 22px box draws the glyph at ~19px (85% of the box). */}
          <EmojiGlyph emoji={emoji.emoji} className="size-5.5" />
        </Center>
      </button>
    );
  }
  return (
    <button
      {...props}
      aria-pressed={selected}
      className={cn(
        "size-7 rounded-md data-[active]:bg-accent",
        selected && "bg-accent ring-1 ring-ring",
      )}
    >
      <Center>
        <EmojiGlyph emoji={emoji.emoji} className="size-5" />
      </Center>
    </button>
  );
}

/**
 * A category drawn BEFORE every emojibase category — "Recent", say. Its emoji
 * are looked up in the loaded data (so they keep their label and tags, and a
 * search finds them there too); one the data does not carry (newer than the
 * picker's `EMOJI_VERSION`) is left out.
 */
export interface EmojiPickerLeadingCategory {
  label: string;
  emojis: readonly Emoji[];
}

/** Variation selectors aside, two spellings of one emoji are one emoji. */
function bareEmoji(emoji: string): string {
  return emoji.replace(/[\uFE0E\uFE0F]/gu, "");
}

/**
 * The emojibase data with `leading` prepended as its own category. The index
 * is one below every real category's, so it sorts first wherever frimousse
 * orders by index, and it is also listed first, for frimousse's own walk.
 */
function withLeadingCategory(
  data: EmojiData,
  leading: EmojiPickerLeadingCategory,
): EmojiData {
  const index = Math.min(0, ...data.categories.map((c) => c.index)) - 1;
  const byEmoji = new Map(data.emojis.map((e) => [bareEmoji(e.emoji), e]));
  const picked = leading.emojis.flatMap((emoji) => {
    const found = byEmoji.get(bareEmoji(emoji));
    return found ? [{ ...found, category: index }] : [];
  });
  if (picked.length === 0) return data;
  return {
    ...data,
    emojis: [...picked, ...data.emojis],
    categories: [{ index, label: leading.label }, ...data.categories],
  };
}

// Module-level so frimousse's memoized rows keep their component identity
// across renders (an inline object would remount every visible row).
const LIST_COMPONENTS = {
  CategoryHeader,
  Row: EmojiRow,
  Emoji: EmojiCell,
};

/** The default resolver, with `leading` prepended to what it returns. */
function withLeading(leading: EmojiPickerLeadingCategory): EmojiDataResolver {
  return async (locale, options) =>
    withLeadingCategory(
      await defaultEmojiDataResolver(locale, options),
      leading,
    );
}

export interface EmojiPickerProps {
  /** Currently-selected emoji, highlighted in the grid. */
  value?: Emoji | null;
  /** Fired with the picked emoji — what the caller stores. */
  onSelect: (emoji: Emoji) => void;
  /** How the picker is drawn; default `compact`. See `EmojiPickerVariant`. */
  variant?: EmojiPickerVariant;
  /** Columns in the grid; default 9. */
  columns?: number;
  /**
   * A category shown before the emojibase ones ("Recent"). Read ONCE, when
   * the picker mounts: its data loads then, and frimousse does not reload it
   * for a changed category — so a caller computes it before mounting, and the
   * row holds still while the user picks.
   */
  leadingCategory?: EmojiPickerLeadingCategory;
  className?: string;
}

/**
 * Searchable, categorized emoji grid over frimousse (headless, virtualized).
 * Its emojibase data comes from the same-origin asset mirror
 * (`/api/asset-mirror/emojibase/en/…`), never a CDN, so it works offline after
 * one warm-up. Renders just the emoji block (header + search + grid) — surface
 * chrome (popover, footer rows) is the caller's, and like `IconPicker` it
 * applies no content inset of its own, landing on its host panel's rail.
 *
 * Mount it only while visible (e.g. inside an open popover): it loads its data
 * on mount.
 *
 * The mirror is the page's own server's, reached by URL (frimousse fetches
 * `<base>/<locale>/data.json` itself): under a transport no URL reaches (an
 * in-browser server — the demo) that URL would load from the page's real
 * server, so the picker says it is unavailable instead.
 */
export function EmojiPicker(props: EmojiPickerProps) {
  const { servesUrls } = useTransport();
  if (!servesUrls) {
    return (
      <Text as="div" variant="caption" tone="muted">
        {unavailableMessage({ feature: "The emoji picker" })}
      </Text>
    );
  }
  return <MirroredEmojiPicker {...props} />;
}

function MirroredEmojiPicker({
  value,
  onSelect,
  variant = "compact",
  columns = DEFAULT_COLUMNS,
  leadingCategory,
  className,
}: EmojiPickerProps) {
  const panel = variant === "panel";
  const [query, setQuery] = useState("");
  // Fixed at mount (see `leadingCategory`): a resolver frimousse is handed
  // once, wrapping the default one, so the leading category is part of the
  // DATA — searched, keyboard-navigated and virtualized like any other.
  const [resolveEmojiData] = useState(() =>
    leadingCategory && leadingCategory.emojis.length > 0
      ? withLeading(leadingCategory)
      : undefined,
  );
  return (
    <Variant.Provider value={variant}>
      <Stack gap="xs" className={className}>
        {panel ? null : <SectionLabel as="span">Emoji</SectionLabel>}
        <Frimousse.Root
          locale={EMOJIBASE_LOCALE}
          columns={columns}
          emojiVersion={EMOJI_VERSION}
          emojibaseUrl={EMOJIBASE_URL}
          resolveEmojiData={resolveEmojiData}
          // A picked emoji is parsed, not cast: an emoji the schema rejects is a
          // broken assumption about the data, and throws here rather than being
          // stored.
          onEmojiSelect={(picked) => onSelect(EmojiSchema.parse(picked.emoji))}
          // eslint-disable-next-line layout/no-adhoc-layout -- frimousse's root is the column that stacks the search field over its self-sizing viewport
          className="isolate flex flex-col gap-xs"
        >
          {/* The shared search field, drawn through frimousse's own input
              (which filters the grid) — controlled, since frimousse has no
              search prop on its root. */}
          <SearchInput
            appearance={panel ? "menu" : "field"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emoji…"
            render={<Frimousse.Search />}
          />
          <Frimousse.Viewport
            className={cn(
              "relative outline-none",
              panel ? "h-[14.75rem]" : "h-64",
            )}
          >
            <Frimousse.Loading>
              <Loading label="Loading emoji…" className="py-2xl text-center" />
            </Frimousse.Loading>
            <Frimousse.Empty className="block py-lg text-center text-caption text-muted-foreground">
              No emoji found.
            </Frimousse.Empty>
            <SelectedEmoji.Provider value={value ?? null}>
              <Frimousse.List
                className="select-none pb-xs"
                components={LIST_COMPONENTS}
              />
            </SelectedEmoji.Provider>
          </Frimousse.Viewport>
        </Frimousse.Root>
      </Stack>
    </Variant.Provider>
  );
}
