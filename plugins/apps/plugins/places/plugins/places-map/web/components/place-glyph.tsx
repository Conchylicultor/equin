import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { PlaceVisual } from "../internal/place-visual";
import { paleTint, todoInk } from "../internal/pin-paint";

/**
 * A place's icon on a disc of its main colour — a list row's leading glyph.
 * Todo places wear the pin's language: the pale tint, the icon in the
 * darkened main colour.
 */
export function PlaceGlyph({ visual }: { visual: PlaceVisual }) {
  const todo = visual.status === "todo";
  return (
    <Center
      as="span"
      className="size-6 rounded-full"
      style={{
        backgroundColor: todo ? paleTint(visual.mainColor) : visual.mainColor,
      }}
    >
      <Icon
        icon={visual.icon}
        active
        className="size-4"
        style={{ color: todo ? todoInk(visual.mainColor) : "white" }}
      />
    </Center>
  );
}

/**
 * A place's gallery cover: its colours as a pale wash (a diagonal blend for
 * several), its icon large in the darkened main colour, and its status as a
 * pill in the corner.
 */
export function PlaceCover({ visual }: { visual: PlaceVisual }) {
  const background =
    visual.colors.length > 1
      ? `linear-gradient(135deg, ${visual.colors.map(paleTint).join(", ")})`
      : paleTint(visual.mainColor);
  return (
    <Center className="relative size-full" style={{ background }}>
      <Icon
        icon={visual.icon}
        active
        className="size-10"
        style={{ color: todoInk(visual.mainColor) }}
      />
      <Pin to="top-right" offset="sm">
        <Badge
          variant={visual.status === "done" ? "success" : "muted"}
          shape="pill"
        >
          {visual.status === "done" ? "✓ Done" : "Todo"}
        </Badge>
      </Pin>
    </Center>
  );
}
