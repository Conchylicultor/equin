import { useState } from "react";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import {
  Layer,
  layerClasses,
} from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { localUndoProps } from "@plugins/primitives/plugins/undo-redo/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  foldResource,
  matchResource,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useAssetUrl } from "@plugins/infra/plugins/endpoints/web";
import {
  useBlockActivate,
  type BlockRendererProps,
} from "@plugins/page/plugins/editor/web";
import {
  prototypeDocument,
  prototypesList,
  type PrototypeMeta,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { prototypeDetailPane } from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import {
  prototypeDetailRoute,
  prototypesApp,
} from "@plugins/apps/plugins/prototypes/plugins/shell/core";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { prototypeBlock, PROTOTYPE_BLOCK_ICON } from "../../core";

/** How many prototypes the picker lists at once — newest edit first. */
const PICKER_LIMIT = 50;

/**
 * A prototype block: the mock a page links to (`<prototype id="proto-…"/>`).
 *
 * The prototype itself, live and interactive in the page (see
 * `PrototypeCard`), its actions revealed on hover.
 *
 * Resolution is free: `prototypesList` is the app-wide live list re-broadcast
 * on every file change, so the document follows an agent's edit live, and an
 * id the list does not carry is a prototype that is not here.
 */
export function PrototypeBlock({ block, editor }: BlockRendererProps) {
  const { prototypeId } = prototypeBlock.parse(block.data);
  const prototypes = useLive(prototypesList);
  const [pickerOpen, setPickerOpen] = useState(false);
  const select = (id: string) => editor.update({ prototypeId: id });

  // Whether the block is asking which prototype to show: unset, or naming one
  // the (loaded) list does not carry. Not while the list is still loading or
  // failed — there is nothing yet to pick from.
  const needsPick =
    prototypeId === "" ||
    foldResource(prototypes, {
      loading: () => false,
      error: () => false,
      ready: (list) => !list.some((p) => p.name === prototypeId),
    });

  // An unset or dangling block is asking which prototype to show: Enter on its
  // caret opens the picker. A resolved one leaves Enter to the host (a new
  // paragraph below).
  useBlockActivate(needsPick ? () => setPickerOpen(true) : null);

  const picker = (trigger: React.ReactElement) => (
    <div className="px-md py-xs">
      <PrototypePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={select}
        trigger={trigger}
      />
    </div>
  );

  if (prototypeId === "") {
    return picker(
      <Row
        className="text-muted-foreground"
        icon={<Icon icon={PROTOTYPE_BLOCK_ICON} />}
      >
        Select a prototype…
      </Row>,
    );
  }

  return matchResource(prototypes, {
    loading: () => (
      <div className="px-md py-xs">
        <Loading variant="block" className="w-full aspect-video rounded-md" />
      </div>
    ),
    ready: (list) => {
      const meta = list.find((p) => p.name === prototypeId);
      // An id the list does not carry: the folder is gone, or was never on
      // this machine. Say so, and offer the picker in its place.
      if (meta === undefined) {
        return picker(
          <Row
            icon={
              <Icon
                icon={PROTOTYPE_BLOCK_ICON}
                className="text-muted-foreground"
              />
            }
          >
            <Placeholder>(prototype not found)</Placeholder>
            <Text variant="caption" tone="muted">
              {prototypeId}
            </Text>
          </Row>,
        );
      }
      return <PrototypeCard meta={meta} />;
    },
  });
}

/**
 * The prototype itself, live and interactive, at the block's own width
 * (prototypes are fluid). No chrome at rest: hovering the block reveals its
 * actions in the top-right corner — Open beside, and a new browser tab in the
 * Prototypes app.
 *
 * The url carries `meta.rev`, a hash of this prototype's files, so an agent's
 * edit reloads it and nothing else does. Sandboxed exactly as the canvas frames
 * it: `allow-same-origin` keeps a prototype fetching its own flat files
 * working — they are first-party files from the user's own prototypes dir.
 * `loading="lazy"`: a page holding many mocks only boots the ones scrolled to.
 */
function PrototypeCard({ meta }: { meta: PrototypeMeta }) {
  const openPane = useOpenPane();
  const url = useAssetUrl(prototypeDocument(meta.name, { v: meta.rev }));
  // `push`: the canvas opens as a column to the RIGHT of the page, so the
  // document that links the mock stays on screen beside it.
  const openBeside = openPane.to(
    prototypeDetailPane,
    { name: meta.name },
    { mode: "push" },
  );

  return (
    <div className="px-md py-xs">
      <Clip
        className={cn(
          hoverRevealGroup,
          "relative w-full aspect-video rounded-md border border-border bg-background",
        )}
      >
        {url.kind === "ready" ? (
          <iframe
            title={meta.title}
            src={url.url}
            loading="lazy"
            sandbox="allow-scripts allow-same-origin"
            className={cn(layerClasses(), "h-full w-full border-0")}
          />
        ) : (
          <Layer>
            <Center className="h-full w-full p-md">
              <Text variant="caption" tone="muted">
                {url.message}
              </Text>
            </Center>
          </Layer>
        )}
        <Pin to="top-right" offset="xs" layer="raised">
          <Stack
            direction="row"
            gap="2xs"
            align="center"
            className={cn(
              hoverRevealTarget,
              "rounded-md border border-border bg-background/80 p-2xs shadow-sm backdrop-blur",
            )}
          >
            <ControlSizeProvider size="xs">
              <IconButton
                icon={navIcons.sidePane}
                label={`Open ${meta.title} beside`}
                {...activationProps(openBeside)}
              />
              <NewTabButton
                variant="ghost"
                href={prototypeDetailRoute.link(prototypesApp, {
                  name: meta.name,
                })}
              />
            </ControlSizeProvider>
          </Stack>
        </Pin>
      </Clip>
    </div>
  );
}

/**
 * A prototype-picker popover: every prototype, newest edit first, filtered by
 * title and blurb. Its open state is the BLOCK's, so the block can open it from
 * its caret activation (Enter) — see page-link's picker for why it must not
 * open itself on mount.
 */
function PrototypePicker({
  trigger,
  onSelect,
  open,
  onOpenChange,
}: {
  trigger: React.ReactElement;
  onSelect: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const prototypes = useLive(prototypesList);
  // Only the keyboard reads this outside the list's own `ready` arm; with no
  // list yet there is nothing for Enter to pick, which is the truth.
  const options = foldResource<typeof prototypes, PrototypeMeta[]>(prototypes, {
    loading: () => [],
    error: () => [],
    ready: (list) => matching(list, query),
  });

  const commit = (meta: PrototypeMeta | undefined) => {
    if (meta === undefined) return;
    onSelect(meta.name);
    onOpenChange(false);
    setQuery("");
  };

  return (
    <InlinePopover
      resetOnClose
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      padding="sm"
    >
      <Stack gap="sm">
        <SearchInput
          appearance="menu"
          // Chrome, not document content: its ⌘Z is the field's own (see
          // page-link's picker for why this is declared, not left implicit).
          {...localUndoProps}
          autoFocus
          placeholder="Search prototypes…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((i) => Math.min(i + 1, options.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              commit(options[activeIndex]);
            }
          }}
        />
        <Scroll className="max-h-64">
          {matchResource(prototypes, {
            loading: () => <Loading variant="rows" />,
            ready: () =>
              options.length === 0 ? (
                <Text
                  as="div"
                  variant="body"
                  className="px-sm py-xs text-muted-foreground"
                >
                  No prototypes found
                </Text>
              ) : (
                <Stack gap="none">
                  {/* eslint-disable-next-line data-view/no-adhoc-row-list -- prototype typeahead menu (transient chrome) */}
                  {options.map((meta, i) => (
                    <Row
                      key={meta.name}
                      selected={i === activeIndex}
                      icon={<Icon icon={PROTOTYPE_BLOCK_ICON} />}
                      onMouseEnter={() => setActiveIndex(i)}
                      onMouseDown={(e: React.MouseEvent) => {
                        e.preventDefault();
                        commit(meta);
                      }}
                    >
                      {/* Title alone: beside a blurb both would ellipsize
                          to nothing in a menu this narrow. */}
                      <Text title={meta.blurb || undefined}>{meta.title}</Text>
                    </Row>
                  ))}
                </Stack>
              ),
          })}
        </Scroll>
      </Stack>
    </InlinePopover>
  );
}

/** The prototypes matching `query` (title, blurb or id), newest edit first. */
function matching(
  prototypes: readonly PrototypeMeta[],
  query: string,
): PrototypeMeta[] {
  const q = query.trim().toLowerCase();
  return prototypes
    .filter(
      (p) =>
        q === "" ||
        p.title.toLowerCase().includes(q) ||
        p.blurb.toLowerCase().includes(q) ||
        p.name.includes(q),
    )
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, PICKER_LIMIT);
}
