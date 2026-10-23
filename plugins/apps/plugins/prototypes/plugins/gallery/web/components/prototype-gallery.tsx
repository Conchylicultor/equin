import {
  DataView,
  defineDataView,
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
import { LaunchAgentPopover } from "@plugins/primitives/plugins/launch/web";
import type { ThumbnailState } from "@plugins/apps/plugins/prototypes/plugins/thumbnails/core";
import { PROTOTYPES_CATEGORY_ID } from "@plugins/apps/plugins/prototypes/core";
import {
  prototypeStatuses,
  prototypeVersionCounts,
  prototypesList,
  type PrototypeMeta,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  PrototypeThumbnail,
  usePrototypeThumbnails,
} from "@plugins/apps/plugins/prototypes/plugins/thumbnails/web";
import { mintPrototypeFolder, newPrototypePrompt } from "./new-prototype";
import { prototypeDetailPane } from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { PrototypeCardActions, type PrototypeGalleryRow } from "../slots";
import { galleryFields, joinGalleryRows } from "../internal/gallery-fields";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");

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
    <div
      className="h-full w-full"
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 70% 45%))`,
      }}
    />
  );
}

/**
 * Gallery surface: a `DataView` over the live prototype list — cards (the
 * prototype as it renders, its `<title>`, blurb, when it was last edited and
 * how many versions it has) or a list. Before its picture exists a card shows
 * an id-tinted swatch. Activating a
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
    // How many versions each prototype has — the card's "v12" token, awaited
    // with the list for the same reason the thumbnails are.
    versionCounts: useLive(prototypeVersionCounts),
  });
  const openPane = useOpenPane();

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
      fields={galleryFields}
      rowKey={(p) => p.name}
      // The card's cover is the prototype as it actually renders (and the list
      // row's thumbnail). The id-tinted swatch stays as what a prototype looks
      // like before its picture exists (or when rendering it failed) — the
      // thumbnail owns the picture, this pane owns the stand-in.
      cover={(p) => ({
        kind: "node",
        node: (
          <PrototypeThumbnail
            state={thumbnails[p.name]}
            fallback={<CoverSwatch meta={p} />}
          />
        ),
      })}
      views={["gallery", "list"]}
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
    />
  );

  return matchResource(result, {
    // The DataView renders the loading and failed states (`readiness`) under
    // its stable chrome; only a ready read reaches the view.
    loading: () => renderList([], {}),
    error: () => renderList([], {}),
    ready: ({ prototypes, thumbnails, statuses, versionCounts }) =>
      renderList(
        joinGalleryRows(prototypes, statuses, versionCounts),
        thumbnails,
      ),
  });
}
