import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  matchResource,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { LaunchAgentPopover } from "@plugins/primitives/plugins/launch/web";
import type { ThumbnailState } from "@plugins/apps/plugins/prototypes/plugins/thumbnails/core";
import { PROTOTYPES_CATEGORY_ID } from "@plugins/apps/plugins/prototypes/core";
import {
  prototypeStatuses,
  prototypesList,
  statusOf,
  type PrototypeMeta,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  PrototypeThumbnail,
  usePrototypeThumbnails,
} from "@plugins/apps/plugins/prototypes/plugins/thumbnails/web";
import { mintPrototypeFolder, newPrototypePrompt } from "./new-prototype";
import { prototypeDetailPane } from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { PrototypeCardActions, type PrototypeGalleryRow } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const warningIcon = symbol("warning");

const PROTOTYPES_VIEW = defineDataView("prototypes.gallery");

/** Deterministic hue from the prototype's id, for the cover swatch. */
function hueFor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

function CoverSwatch({ meta }: { meta: PrototypeMeta }) {
  const hue = hueFor(meta.name);
  return (
    <Overlay
      className="h-full w-full"
      // `fill`, not in-flow: the cover box is sized by the card, and an in-flow
      // child's `h-full` would resolve against Overlay's auto-height wrapper —
      // i.e. against nothing — leaving the swatch blank.
      fill
      // A marker only — the problems themselves are listed in the detail pane,
      // where there is room to read them. `above` is pointer-events-none, so a
      // tooltip here would never fire and the corner would go dead to clicks.
      above={
        meta.problems.length === 0 ? null : (
          <Pin to="top-right" offset="xs">
            <Badge variant="warning" icon={<Icon icon={warningIcon} />}>
              {meta.problems.length}
            </Badge>
          </Pin>
        )
      }
    >
      <div
        className="h-full w-full"
        style={{
          background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 70% 45%))`,
        }}
      />
    </Overlay>
  );
}

/**
 * Gallery surface: a `DataView` gallery over the live prototype list. Each card
 * shows the prototype's `<title>` + blurb over an id-tinted cover. Activating a
 * card opens the Focus/Compare detail pane. "New prototype" mints an empty
 * prototype folder and opens the launch-agent popover on it, so the background
 * agent it fires is handed a folder that already exists.
 */
export function PrototypeGallery() {
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();
  // Both subscriptions are taken HERE, side by side, and the cards wait for
  // both. A value is filled by its subscription's first answer, asked for when
  // its first subscriber mounts, so a card that subscribed to its own thumbnail
  // could not ask until the list had already painted — every load showed the
  // stand-in swatch for one round trip and then swapped in the picture. Asking
  // for both at once costs no extra wait (they are answered in parallel) and
  // the cover is right the first time it is painted.
  const result = useCombinedResources({
    prototypes: useLive(prototypesList),
    thumbnails: usePrototypeThumbnails(),
    // Whether each prototype is pinned / marked Done — joined onto the rows below, and
    // awaited with the list so a Done card never paints as not done first.
    statuses: useLive(prototypeStatuses),
  });
  const openPane = useOpenPane();

  // `title` is what the author named the prototype (its `<title>`), so it is the
  // display field; `name` is the minted id the URL and the row key use — opaque,
  // so it is a searchable column and never the label.
  const fields: FieldDef<PrototypeGalleryRow>[] = [
    {
      id: "title",
      label: "Title",
      type: "text",
      primary: true,
      value: (p) => p.title,
    },
    { id: "blurb", label: "Blurb", type: "text", value: (p) => p.blurb },
    { id: "name", label: "Folder", type: "text", value: (p) => p.name },
    // Sort keys: hidden on the card, offered in the sort and filter menus.
    {
      id: "createdAt",
      label: "Created",
      type: "date",
      value: (p) => new Date(p.createdAt),
      cell: (p) => <RelativeTime date={new Date(p.createdAt)} />,
      visible: false,
    },
    {
      id: "modifiedAt",
      label: "Last modified",
      type: "date",
      value: (p) => new Date(p.modifiedAt),
      cell: (p) => <RelativeTime date={new Date(p.modifiedAt)} />,
      visible: false,
    },
    // Filter / group-by only — the card already shows it, as its pin and
    // checkbox. An enum rather than two bools, because this field is READ as
    // section headings (the gallery groups by it by default, in this options
    // order) and as filter values, where "Pinned" / "In progress" / "Done" say
    // what "No" / "Yes" cannot. A pin outranks Done: pinning a finished
    // prototype is asking to keep it in view.
    {
      id: "status",
      label: "Status",
      type: "enum",
      options: [
        { value: "pinned", label: "Pinned" },
        { value: "in-progress", label: "In progress" },
        { value: "done", label: "Done" },
      ],
      value: (p) => (p.pinned ? "pinned" : p.done ? "done" : "in-progress"),
      visible: false,
    },
  ];

  const newButton = (
    <LaunchAgentPopover
      draftKey="new-prototype"
      trigger={
        <Button variant="default">
          <Icon icon={addIcon} />
          New prototype
        </Button>
      }
      title="New prototype"
      description="Launch an agent to scaffold a new throwaway UI prototype."
      placeholder="Extra context (optional) — e.g. desired style, layout, reference…"
      align="end"
      getRequest={async (userText) => {
        const id = await mintPrototypeFolder(fetchEndpoint, toast);
        const parts = [newPrototypePrompt(id)];
        if (userText.trim())
          parts.push(`Additional context: ${userText.trim()}`);
        return {
          prompt: parts.join("\n\n"),
          categoryId: PROTOTYPES_CATEGORY_ID,
        };
      }}
    />
  );

  const renderList = (
    rows: PrototypeGalleryRow[],
    thumbnails: Record<string, ThumbnailState>,
  ) => (
    <DataView<PrototypeGalleryRow>
      rows={rows}
      fields={fields}
      rowKey={(p) => p.name}
      views={["gallery"]}
      defaultView="gallery"
      storageKey={PROTOTYPES_VIEW}
      readiness={result}
      itemActions={PrototypeCardActions}
      rowTone={(p) => (p.done ? "muted" : "default")}
      rowActivation={(p) =>
        openPane.to(prototypeDetailPane, { name: p.name }, { mode: "push" })
      }
      actions={newButton}
      emptyState="No prototypes yet. New prototype mints one and launches an agent to design it."
      viewOptions={{
        gallery: {
          minCardWidth: 224,
          // The card's cover is the prototype as it actually renders. The
          // id-tinted swatch stays as what a prototype looks like before its
          // picture exists (or when rendering it failed) — the thumbnail owns
          // the picture, this pane owns the stand-in.
          cover: (p: PrototypeGalleryRow) => ({
            kind: "node",
            node: (
              <PrototypeThumbnail
                state={thumbnails[p.name]}
                fallback={<CoverSwatch meta={p} />}
              />
            ),
          }),
        },
      }}
    />
  );

  return matchResource(result, {
    // The DataView renders the loading and failed states (`readiness`) under
    // its stable chrome; only a ready read reaches the view.
    loading: () => renderList([], {}),
    error: () => renderList([], {}),
    ready: ({ prototypes, thumbnails, statuses }) =>
      renderList(
        prototypes.map((p) => {
          const { done, pinned } = statusOf(statuses, p.name);
          return { ...p, done, pinned };
        }),
        thumbnails,
      ),
  });
}
