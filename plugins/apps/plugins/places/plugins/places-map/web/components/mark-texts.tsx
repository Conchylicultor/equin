import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { MapMark } from "@plugins/map/core";

/**
 * The mark's centred texts (its page number), drawn as the map draws them on
 * its canvas — the lifted pin is the DOM's, so it draws its own.
 */
export function MarkTexts({ mark }: { mark: MapMark }) {
  return (mark.texts ?? []).map((t) =>
    t.at === "center" ? (
      <Placed
        key={`${t.text}@${t.point?.x ?? "a"}`}
        x={{ center: (t.point ?? mark.anchor).x }}
        y={{ center: (t.point ?? mark.anchor).y }}
        decorative
        style={{ color: t.color }}
      >
        <Text variant="count">{t.text}</Text>
      </Placed>
    ) : null,
  );
}
