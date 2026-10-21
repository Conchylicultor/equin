import { useState, type ReactNode } from "react";
import {
  useDataViewControls,
  useFlatRows,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  MAPS_BLOCKER_BODY,
  MapsAccessAction,
} from "@plugins/integrations/plugins/google-maps/web";
import {
  isRoleTag,
  placeFlags,
  placeName,
  tagPath,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { placeSearchText } from "../internal/fields";
import { looksLikeQuestion } from "../internal/question";
import { placeVisual } from "../internal/place-visual";
import type { GoogleSearchState } from "../internal/use-google-search";
import { GoogleResultCard, type GoogleHit } from "./google-result-card";
import { PlaceGlyph } from "./place-glyph";
import { AskHistory } from "./ask-history";

const customPinIcon = symbol("push-pin");
const sonnetIcon = symbol("auto-awesome");

/** What Ask Sonnet offers with nothing typed: questions it answers well. */
const EXAMPLE_QUESTIONS = [
  "chinese restaurant open tuesday",
  "coffee to work from, quiet, with wifi",
  "cheap dinner for 6 with kids tonight",
] as const;

/** Your places listed by name; the rest are on the map. */
const PLACES_SHOWN = 4;
/** Google cards before "Show more". */
const GOOGLE_SHOWN = 5;

export interface UniversalSearchPanelProps {
  places: readonly Place[];
  tags: readonly PlaceTag[];
  query: string;
  google: GoogleSearchState;
  /** Saved places by their Google id: a hit already saved says so. */
  savedByGoogleId: ReadonlyMap<string, Place>;
  /** The Google hit hovered here or on the map (linked both ways). */
  hoveredGoogleId: string | null;
  onHoverGoogle: (placeId: string | null) => void;
  onOpenPlace: (place: Place) => void;
  /** Open a hit's detail card (one with a position). */
  onOpenHit: (hit: GoogleHit) => void;
  onSave: (hit: GoogleHit) => Promise<void>;
  /** A save said Google Maps is not set up. */
  saveNotConfigured: boolean;
  onDropCustom: (name: string) => void;
  /** Hand a question to Sonnet, as a background run. */
  onAsk: (question: string) => void;
  /** Why Sonnet cannot be asked now (no computer, the map not placed yet); null when it can. */
  askBlocked: string | null;
  /** Reopen an earlier question's run in the side card. */
  onOpenRun: (conversationId: string) => void;
}

/**
 * The panel under "Search or add places": your places the query matches —
 * the same rows the map shows, since it reads the view's own filter and
 * search — and Google's hits as cards to save, each proposed on the map as a
 * ghost pin. Its last row drops a custom pin, for a place Google does not know.
 */
export function UniversalSearchPanel(props: UniversalSearchPanelProps) {
  const { query, onDropCustom, onAsk, askBlocked, onOpenRun } = props;
  const typed = query.trim();
  const question = looksLikeQuestion(typed);
  return (
    <ControlPanel aria-label="Search or add places">
      {typed === "" ? (
        <>
          <ControlPanel.Section>
            <ControlPanel.Empty>
              Search your places, or find new ones on Google — a name, a kind of
              place, an address. Saving tags it from its Google type.
            </ControlPanel.Empty>
          </ControlPanel.Section>
          <ControlPanel.Section
            label={
              <Line className="gap-xs">
                Ask Sonnet
                <Text variant="caption" tone="muted">
                  · describe what you want, in words
                </Text>
              </Line>
            }
          >
            {EXAMPLE_QUESTIONS.map((q) => (
              <ControlPanel.Row
                key={q}
                icon={<Icon icon={sonnetIcon} className="text-primary-text" />}
                disabled={askBlocked !== null}
                onSelect={() => onAsk(q)}
              >
                {q}
              </ControlPanel.Row>
            ))}
          </ControlPanel.Section>
          <AskHistory onOpenRun={onOpenRun} />
        </>
      ) : (
        <>
          {question ? (
            <AskRow query={typed} hot blocked={askBlocked} onAsk={onAsk} />
          ) : null}
          <YourPlaces {...props} />
          <GoogleSection {...props} />
          {question ? null : (
            <AskRow
              query={typed}
              hot={false}
              blocked={askBlocked}
              onAsk={onAsk}
            />
          )}
        </>
      )}
      <ControlPanel.Section>
        <ControlPanel.Row
          icon={<Icon icon={customPinIcon} />}
          description="Not on Google (closed, an event, a spot): name it and click the map"
          onSelect={() => onDropCustom(typed)}
        >
          Drop a custom pin
        </ControlPanel.Row>
      </ControlPanel.Section>
    </ControlPanel>
  );
}

/**
 * "Ask Sonnet “…”": the query handed to Sonnet as a background run. It leads
 * the panel when the query reads like a question (`hot`: Enter asks), and
 * closes it otherwise (⌘Enter asks).
 */
function AskRow({
  query,
  hot,
  blocked,
  onAsk,
}: {
  query: string;
  hot: boolean;
  blocked: string | null;
  onAsk: (question: string) => void;
}) {
  return (
    <ControlPanel.Section>
      <ControlPanel.Row
        icon={<Icon icon={sonnetIcon} className="text-primary-text" />}
        description={
          blocked ??
          `${hot ? "Looks like a question — " : ""}searches Google, reads hours and ratings, picks for you · runs in the background`
        }
        trailing={<Kbd>{hot ? "⏎" : "⌘⏎"}</Kbd>}
        disabled={blocked !== null}
        onSelect={() => onAsk(query)}
      >
        {`Ask Sonnet “${query}”`}
      </ControlPanel.Row>
    </ControlPanel.Section>
  );
}

/** "Lyon · Food, Wine bar": where it is and how it is tagged. */
function placeLine(place: Place, tags: readonly PlaceTag[]): string {
  const tagNames = place.tags
    .filter((id) => !isRoleTag(id, tags))
    .map((id) => tagPath(id, tags).at(-1)?.name)
    .filter((n): n is string => n !== undefined);
  return [place.address, tagNames.join(", ")]
    .filter((p) => p !== "")
    .join(" · ");
}

function YourPlaces({
  places,
  tags,
  onOpenPlace,
}: UniversalSearchPanelProps): ReactNode {
  // The view's own pipeline (its filter and its search), as the tag sidebar's
  // count reads it: the panel lists exactly what the map shows.
  const { fields, activeState, filter } = useDataViewControls();
  const matches = useFlatRows(
    places,
    fields as FieldDef<Place>[],
    activeState,
    filter.resolveOperatorSet,
    placeSearchText,
  );
  const more = matches.length - PLACES_SHOWN;
  return (
    <ControlPanel.Section
      label={
        <Line className="gap-xs">
          {`Your places ${matches.length}`}
          <Text variant="caption" tone="muted">
            · filtered on the map
          </Text>
        </Line>
      }
    >
      {matches.length === 0 ? (
        <ControlPanel.Empty>None of your places match.</ControlPanel.Empty>
      ) : (
        <>
          {matches.slice(0, PLACES_SHOWN).map((place) => {
            const flags = placeFlags(place, tags);
            const line = placeLine(place, tags);
            return (
              <ControlPanel.Row
                key={place.id}
                icon={<PlaceGlyph visual={placeVisual(place, tags)} />}
                description={line === "" ? "No address" : line}
                trailing={
                  flags.been ? (
                    <Badge variant="success">Been</Badge>
                  ) : flags.want ? (
                    <Badge variant="info">Want</Badge>
                  ) : null
                }
                onSelect={() => onOpenPlace(place)}
              >
                {placeName(place)}
              </ControlPanel.Row>
            );
          })}
          {more > 0 ? (
            <ControlPanel.Empty>{`+${more} more on the map`}</ControlPanel.Empty>
          ) : null}
        </>
      )}
    </ControlPanel.Section>
  );
}

/** "Ratings paused until Nov 1" — the date a downgrade lifts. */
function untilDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function GoogleSection({
  google,
  savedByGoogleId,
  hoveredGoogleId,
  onHoverGoogle,
  onOpenPlace,
  onSave,
  saveNotConfigured,
  onOpenHit,
}: UniversalSearchPanelProps): ReactNode {
  const [showAll, setShowAll] = useState(false);
  const hits = google.kind === "answer" ? google.hits : [];

  const label = (
    <Line className="gap-xs">
      {google.kind === "answer" ? `Google ${hits.length}` : "Google"}
      {google.kind === "loading" ||
      (google.kind === "answer" && google.refreshing) ? (
        <Spinner />
      ) : null}
      <Text variant="caption" tone="muted">
        · around this map area
      </Text>
    </Line>
  );

  if (saveNotConfigured || google.kind === "not-configured") {
    return (
      <ControlPanel.Section label={label}>
        <Stack gap="sm">
          <Text variant="caption" tone="muted">
            {MAPS_BLOCKER_BODY["not-configured"]}
          </Text>
          <MapsAccessAction />
        </Stack>
      </ControlPanel.Section>
    );
  }
  return (
    <ControlPanel.Section
      label={label}
      {...(google.kind === "answer" && google.resumesAt !== undefined
        ? {
            description:
              google.rung === "basic"
                ? `Ratings paused until ${untilDay(google.resumesAt)} · this month's free Google quota is used`
                : `Names only until ${untilDay(google.resumesAt)} · this month's free Google quota is used`,
          }
        : {})}
    >
      {google.kind === "idle" ? (
        <ControlPanel.Empty>
          Type one more letter to search Google.
        </ControlPanel.Empty>
      ) : google.kind === "loading" ? (
        <Loading variant="rows" count={2} />
      ) : google.kind === "error" ? (
        <ResourceErrorInline
          variant="block"
          subject="the Google Places search"
          error={google.error}
          refetch={google.refetch}
        />
      ) : hits.length === 0 ? (
        <ControlPanel.Empty>
          No Google results here — pan the map to search elsewhere.
        </ControlPanel.Empty>
      ) : (
        <div>
          <Stack gap="2xs">
            {(showAll ? hits : hits.slice(0, GOOGLE_SHOWN)).map((hit) => {
              const saved = savedByGoogleId.get(hit.placeId);
              return (
                <GoogleResultCard
                  key={hit.placeId}
                  hit={hit}
                  highlighted={hit.placeId === hoveredGoogleId}
                  onHover={onHoverGoogle}
                  saved={saved !== undefined}
                  onSave={() => onSave(hit)}
                  onOpenSaved={() => {
                    if (saved !== undefined) onOpenPlace(saved);
                  }}
                  {...(hit.result === undefined
                    ? {}
                    : { onOpen: () => onOpenHit(hit) })}
                />
              );
            })}
          </Stack>
          {!showAll && hits.length > GOOGLE_SHOWN ? (
            <ControlPanel.Row onSelect={() => setShowAll(true)}>
              {`Show ${hits.length - GOOGLE_SHOWN} more`}
            </ControlPanel.Row>
          ) : null}
        </div>
      )}
    </ControlPanel.Section>
  );
}
