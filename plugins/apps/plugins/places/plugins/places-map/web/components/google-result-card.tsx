import type { ReactNode } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { PlaceCandidate } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import type { GoogleResultVisual } from "../internal/google-result";
import { paleTint, washInk } from "../internal/pin-paint";
import { OpenNowLine, RatingLine } from "./place-facts";

const saveIcon = symbol("add");
const savedIcon = symbol("check");
const offMapIcon = symbol("north-east");
const whyIcon = symbol("auto-awesome");

/** One Google hit as a card shows it, whatever rung of the search gave it. */
export interface GoogleHit {
  placeId: string;
  name: string;
  /** "Sichuan restaurant · 184 Rue Saint-Martin" — or the autocomplete second line. */
  line: string | undefined;
  /** The full hit (`rich` / `basic` rungs); absent for an autocomplete name. */
  result: PlaceCandidate | undefined;
  visual: GoogleResultVisual;
  /** Outside the map's view (the search is biased to it, not limited by it). */
  offMap: boolean;
}

/**
 * A Google result in the search panel: the would-be tags' colour and icon,
 * the name, Google's rating · count · price, its type and address, whether it
 * is open now — and Save, which adds it auto-tagged; a place already saved
 * says so and opens it instead. Hovering it lifts its ghost pin on the map,
 * and its pin hovered highlights it (`highlighted`).
 */
export function GoogleResultCard({
  hit,
  highlighted,
  onHover,
  saved,
  onSave,
  onOpenSaved,
  pick,
}: {
  hit: GoogleHit;
  highlighted: boolean;
  onHover: (placeId: string | null) => void;
  saved: boolean;
  onSave: () => Promise<void>;
  onOpenSaved: () => void;
  /**
   * One of Sonnet's picks: its rank on the icon (the number its pin carries)
   * and why it fits, in place of the open-now line — the reason names the
   * hours it checked.
   */
  pick?: { n: number; why: string };
}): ReactNode {
  const { result, visual } = hit;
  return (
    <div
      data-google-place-id={hit.placeId}
      onMouseEnter={() => onHover(hit.placeId)}
      onMouseLeave={() => onHover(null)}
      className={cn(
        "rounded-panel-row p-sm transition-colors",
        highlighted && "bg-hover-fill",
      )}
    >
      <Stack direction="row" gap="sm" align="start">
        <div className="relative">
          <Center
            aria-hidden
            className="size-14 rounded-md"
            style={{ backgroundColor: paleTint(visual.mainColor) }}
          >
            <Icon
              icon={visual.icon}
              active
              className="size-7"
              style={{ color: washInk(visual.mainColor) }}
            />
          </Center>
          {pick === undefined ? null : (
            <Pin to="top-right" offset="xs" outset decorative>
              <Center className="size-5 rounded-full bg-primary text-primary-foreground ring-2 ring-background">
                <Text variant="count">{pick.n}</Text>
              </Center>
            </Pin>
          )}
        </div>
        <Fill>
          <Stack gap="2xs">
            <Line className="gap-sm">
              <Text variant="label" tone="strong">
                {hit.name}
              </Text>
              <Fill />
              {saved ? (
                <Button
                  variant="ghost"
                  shape="pill"
                  className="text-success"
                  onClick={onOpenSaved}
                >
                  <Icon icon={savedIcon} />
                  Saved
                </Button>
              ) : (
                <Button
                  variant="outline"
                  shape="pill"
                  onClick={onSave}
                  aria-label={`Save ${hit.name}`}
                >
                  <Icon icon={saveIcon} />
                  Save
                </Button>
              )}
            </Line>
            {result === undefined ? null : <RatingLine details={result} />}
            {hit.line === undefined ? null : (
              <Text variant="caption" tone="muted">
                {hit.line}
              </Text>
            )}
            {pick === undefined ? null : (
              <Stack
                direction="row"
                gap="xs"
                align="start"
                className="rounded-md bg-primary/10 px-sm py-2xs text-primary-text"
              >
                <Icon icon={whyIcon} className="size-3.5" />
                <Text variant="caption">{pick.why}</Text>
              </Stack>
            )}
            {pick !== undefined ||
            (result === undefined && !hit.offMap) ? null : (
              <Line className="gap-sm">
                {result === undefined ? null : <OpenNowLine details={result} />}
                <Fill />
                {hit.offMap ? (
                  <Line className="gap-2xs text-muted-foreground">
                    <Icon icon={offMapIcon} className="size-3.5" />
                    <Text variant="caption" tone="muted">
                      off the map
                    </Text>
                  </Line>
                ) : null}
              </Line>
            )}
          </Stack>
        </Fill>
      </Stack>
    </div>
  );
}
