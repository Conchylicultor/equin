import type { ReactNode } from "react";
import {
  DataView,
  defineDataView,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import type { GalleryViewOptions } from "@plugins/primitives/plugins/data-view/plugins/gallery/web";
import { beforeAfterPairs, type BeforeAfterPair } from "../../core";
import { SplitThumb } from "./pair-image";

const PAIR_GALLERY_VIEW = defineDataView("conversations.before-after.gallery");

const pairsSource = liveDataSource(beforeAfterPairs, {
  surface: PAIR_GALLERY_VIEW,
  searchable: ["title"],
  unscoped: {
    reason:
      "one conversation's before / after pairs, a handful at most: custom columns would sort and filter nothing worth a scope",
  },
});

/** No band: the pane's filmstrip is the cards alone — no search, no views. */
function StripFrame({ body }: HostedToolbarParts): ReactNode {
  return body;
}

const STRIP_TOOLBAR: HostedToolbar = { kind: "hosted", frame: StripFrame };

const STRIP_OPTIONS: { gallery: GalleryViewOptions } = {
  gallery: { layout: "strip" },
};

/** Only the title is written under a card; the rest is the viewer's caption. */
const TITLE_ONLY = {
  route: "hidden",
  conversationId: "hidden",
  toolUseId: "hidden",
  createdAt: "hidden",
} as const;

/** A card's cover: the pair split before | after. */
function pairCover(pair: BeforeAfterPair) {
  return { kind: "node" as const, node: <SplitThumb pair={pair} /> };
}

/**
 * Every pair of one conversation, as the pane's filmstrip: a gallery DataView
 * in its strip layout (one sideways-scrolling row of split before | after
 * thumbnails, the title under each), no toolbar. The selected pair's card is
 * ringed; activating a card selects its pair.
 */
export function PairGallery({
  conversationId,
  selectedId,
  onSelect,
}: {
  conversationId: string;
  selectedId: string;
  onSelect: (id: string) => void;
}): ReactNode {
  return (
    <DataView<BeforeAfterPair>
      source={pairsSource.scoped({ where: { conversationId } })}
      views={["gallery"]}
      defaultView="pairs"
      toolbar={STRIP_TOOLBAR}
      viewOptions={STRIP_OPTIONS}
      place={TITLE_ONLY}
      cover={pairCover}
      selectedRowId={selectedId}
      rowActivation={(pair) => () => onSelect(pair.id)}
      emptyState="No pairs in this conversation."
    />
  );
}
