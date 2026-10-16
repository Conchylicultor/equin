import type {
  LatLng,
  MapMark,
  MapMarkText,
  MapTileScheme,
} from "@plugins/map/core";
import { MAP_LABEL_PAINT, type MapTextStyle } from "@plugins/map/web";
import { hitTest, type HitBox } from "../../core";
import type { PinPainter } from "./painter";
import { SpriteCache } from "./sprites";

/** One mark the layer holds: a pin or a cluster, placed on its point. */
export interface SceneItem {
  /** The planned item's id (`PlannedItem.id`). */
  id: string;
  position: LatLng;
  mark: MapMark;
  z: number;
  /** Texts beyond the mark's own (a spot's count). */
  texts: readonly MapMarkText[];
  /**
   * Drawn in the DOM right now (hovered, active): left off the surface, but
   * still hit — so the pointer resting on a lifted pin keeps it lifted.
   */
  lifted: boolean;
}

/** What one frame needs from the renderer hosting the layer. */
export interface LayerFrame {
  /** The surface's size, CSS px. */
  width: number;
  height: number;
  dpr: number;
  /** A point on the surface, CSS px from its top-left. */
  project: (position: LatLng) => { x: number; y: number };
  tiles: MapTileScheme;
  text: MapTextStyle;
}

interface Placed {
  item: SceneItem;
  box: HitBox;
}

/**
 * Every pin at rest, drawn from its mark on one surface: the scene is data
 * (`setScene`), a frame is a projection (`render`) — so a zoom or pan frame
 * costs one sprite draw per pin on screen and no layout at all. Hit testing
 * answers from the boxes of the last frame.
 *
 * A new scene is held back until every sprite it draws is rasterized, then
 * swapped in whole — pins never appear one by one; the previous scene stays
 * on screen meanwhile.
 */
export class PinLayer {
  private readonly sprites = new SpriteCache();
  private scene: readonly SceneItem[] = [];
  private placed: Placed[] = [];
  private latest = 0;
  private disposed = false;

  constructor(
    private readonly painter: PinPainter,
    /** Something changed the next frame would show: render again. */
    private readonly invalidate: () => void,
    /** A sprite could not be made — the caller rethrows it where it can be seen. */
    private readonly fail: (err: unknown) => void,
  ) {}

  setScene(items: readonly SceneItem[], dpr: number): void {
    const generation = ++this.latest;
    const missing = items.filter(
      (i) => this.sprites.get(i.mark, dpr) === undefined,
    );
    if (missing.length === 0) {
      this.scene = items;
      this.invalidate();
      return;
    }
    Promise.all(missing.map((i) => this.sprites.load(i.mark, dpr))).then(
      () => {
        if (this.disposed || generation !== this.latest) return;
        this.scene = items;
        this.invalidate();
      },
      (err: unknown) => {
        if (!this.disposed) this.fail(err);
      },
    );
  }

  render(frame: LayerFrame): void {
    const { width, height, dpr } = frame;
    this.painter.begin(width, height, dpr);
    const placed: Placed[] = [];
    for (const item of this.scene) {
      const at = frame.project(item.position);
      const { mark } = item;
      const left = at.x - mark.anchor.x;
      const top = at.y - mark.anchor.y;
      // Off screen (a label's reach of slack): nothing to draw or hit.
      if (
        left > width ||
        top > height ||
        left + mark.width + 200 < 0 ||
        top + mark.height < 0
      ) {
        continue;
      }
      placed.push({
        item,
        box: {
          id: item.id,
          left,
          top,
          width: mark.width,
          height: mark.height,
          z: item.z,
        },
      });
    }
    placed.sort((a, b) => a.item.z - b.item.z);
    const paint = MAP_LABEL_PAINT[frame.tiles];
    const fonts = { label: frame.text.font, count: frame.text.countFont };
    for (const { item, box } of placed) {
      if (item.lifted) continue;
      const bitmap = this.sprites.get(item.mark, dpr);
      // Swapped in only once rasterized, at this ratio: a ratio change waits for the next scene.
      if (bitmap === undefined) continue;
      this.painter.sprite(bitmap, box.left, box.top, box.width, box.height);
      const { mark } = item;
      for (const t of [...(mark.texts ?? []), ...item.texts]) {
        if (t.at === "beside") {
          this.painter.text(
            {
              at: "beside",
              text: t.text,
              x: box.left + mark.labelAt.x,
              y: box.top + mark.labelAt.centerY,
              ink: paint.ink,
              halo: paint.halo,
            },
            fonts,
          );
        } else {
          this.painter.text(
            {
              at: "center",
              text: t.text,
              x: box.left + mark.anchor.x,
              y: box.top + mark.anchor.y,
              color: t.color,
            },
            fonts,
          );
        }
      }
    }
    this.placed = placed;
  }

  /** The item a press at `(x, y)` (surface CSS px) lands on, as of the last frame. */
  hitTest(x: number, y: number): SceneItem | null {
    const hit = hitTest(
      this.placed.map((p) => p.box),
      x,
      y,
    );
    return hit === null
      ? null
      : (this.placed.find((p) => p.box === hit)?.item ?? null);
  }

  /** The box `id` was last drawn in (surface CSS px), or `null` off screen. */
  boxOf(id: string): HitBox | null {
    return this.placed.find((p) => p.item.id === id)?.box ?? null;
  }

  /** Every item drawn last frame, with its box: what is on screen. */
  onScreen(): readonly { item: SceneItem; box: HitBox }[] {
    return this.placed;
  }

  dispose(): void {
    this.disposed = true;
    this.sprites.dispose();
  }
}
