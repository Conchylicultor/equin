import type { ReactNode } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  type ResolveResult,
  PaneMessage,
} from "@plugins/primitives/plugins/pane/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { eventsApp } from "@plugins/apps/plugins/events/plugins/shell/core";
import { SourcesList } from "./components/sources-list";
import { useEventSource } from "./internal/use-source";
import { EventSourceDetail } from "./slots";

/** The Sources surface: `/events/sources`. */
const eventSourcesRoute = defineRoute({
  id: "event-sources",
  segment: "sources",
});

export const eventSourcesPane = Pane.define({
  title: "Sources",
  route: eventSourcesRoute,
  app: eventsApp,
  component: EventSourcesPaneView,
});

/**
 * One source: `/events/sources/source/:sourceId`.
 *
 * Chaining under the list keeps it beside this pane as a Miller column, which is
 * also what puts the list segment in the URL — a pane's path is its route chain,
 * so this cannot be the design doc's `/events/s/:id` without orphaning the list.
 * The chain is what types every descendant's params as the full `{ sourceId, … }`
 * too, so a run can be opened by a caller holding no source route of its own.
 *
 * The `source/` prefix is mandatory AND must be globally distinct, for two
 * separate reasons: a segment starting with a bare `:param` is REJECTED
 * (URL-parsing ambiguity), and pane segments are matched across the whole app —
 * param names do not disambiguate, so a short `s/:sourceId` collides with
 * Story's `s/:pageId` (`pane:segments-unique` catches it at build; left unfixed
 * it throws at runtime on navigation). Spelling the noun in full is the same
 * shape `deploy/servers` uses for `server/:serverId` under its `servers` list.
 */
export const eventSourceDetailRoute = defineRoute({
  id: "event-source-detail",
  segment: "source/:sourceId",
  parent: eventSourcesRoute,
});

export const eventSourceDetailPane = Pane.define({
  route: eventSourceDetailRoute,
  app: eventsApp,
  component: EventSourceDetailPaneView,
  useResolve: useResolveSource,
  title: { useText: useSourceTitle, fallback: "Source" },
});

/** The source's name once it is found; undefined otherwise (the fallback shows). */
function useSourceTitle({
  sourceId,
}: {
  sourceId: string;
}): string | undefined {
  const lookup = useEventSource(sourceId);
  return lookup.status === "found" ? lookup.source.name : undefined;
}

function useResolveSource({ sourceId }: { sourceId: string }): ResolveResult {
  // The by-id lookup already answers in the resolve vocabulary; an errored
  // subscription is its own arm, so a deep link survives a socket blip.
  return useEventSource(sourceId);
}

function EventSourcesPaneView(): ReactNode {
  return (
    <PaneChrome pane={eventSourcesPane}>
      <SourcesList />
    </PaneChrome>
  );
}

function EventSourceDetailPaneView(): ReactNode {
  const { sourceId } = eventSourceDetailPane.useParams();
  const lookup = useEventSource(sourceId);

  if (lookup.status === "error") {
    return (
      <PaneChrome pane={eventSourceDetailPane}>
        <PaneMessage>
          <Placeholder tone="error">{lookup.error.message}</Placeholder>
        </PaneMessage>
      </PaneChrome>
    );
  }

  if (lookup.status === "missing") {
    return (
      <PaneChrome pane={eventSourceDetailPane}>
        <PaneMessage>
          <Placeholder>This source no longer exists.</Placeholder>
        </PaneMessage>
      </PaneChrome>
    );
  }

  // The whole pane body is the one section slot: Settings, Schedule, Status and
  // Runs are peer contributions and the host owns every card. Sections render
  // while the lookup is still pending — each owns its own loading state, so the
  // pane does not stall behind one gate.
  return (
    <PaneChrome pane={eventSourceDetailPane}>
      <EventSourceDetail.Host sourceId={sourceId} />
    </PaneChrome>
  );
}
