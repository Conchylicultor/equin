import type { ReactNode } from "react";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  placeName,
  type Place,
} from "@plugins/apps/plugins/places/plugins/places-core/core";

/**
 * The map is asked for a point: to drop a new custom place (named here
 * first), or to move a custom place's pin.
 */
export type PinPick =
  { kind: "drop"; name: string } | { kind: "move"; place: Place };

/** The name a drop will create, or null while there is none to drop yet. */
export function dropName(pick: PinPick): string | null {
  if (pick.kind !== "drop") return null;
  const name = pick.name.trim();
  return name === "" ? null : name;
}

/**
 * The floating bar while the map is in pick mode: the new pin's name (a drop
 * needs one before the map takes a click), what a click will do, and Cancel.
 */
export function PinPickBar({
  pick,
  onNameChange,
  onCancel,
}: {
  pick: PinPick;
  onNameChange: (name: string) => void;
  onCancel: () => void;
}): ReactNode {
  const hint =
    pick.kind === "move"
      ? `Click the map where “${placeName(pick.place)}” goes`
      : dropName(pick) === null
        ? "Name the pin, then click the map where it goes"
        : "Click the map where it goes";
  return (
    <Surface level="overlay" className="p-sm">
      <Line className="gap-sm">
        {pick.kind === "drop" ? (
          <Input
            autoFocus
            value={pick.name}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
            }}
            placeholder="Name the pin"
            aria-label="Custom pin name"
            className="w-56"
          />
        ) : null}
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </Line>
    </Surface>
  );
}
