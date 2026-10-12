import type { ReactElement } from "react";
import {
  exhibitGroupOf,
  type Exhibit,
  type ExhibitRuntime,
  type ExhibitWidths,
} from "@plugins/plugin-meta/plugins/exhibits/core";
import {
  Badge,
  type BadgeVariant,
} from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useExhibits } from "../use-exhibits";
import { ExhibitView } from "./exhibit-view";

// An app exhibit may declare no widths ("a consumer supplies its own"): the
// gallery shows it at a narrow, a medium and a wide container.
const APP_FALLBACK_WIDTHS: ExhibitWidths = [360, 640, 960];

const RUNTIME_BADGE: Record<
  ExhibitRuntime,
  { label: string; variant: BadgeVariant }
> = {
  isolated: { label: "isolated", variant: "muted" },
  "isolated-region": { label: "region", variant: "info" },
  app: { label: "app", variant: "primary" },
};

function widthsOf(exhibit: Exhibit): ExhibitWidths {
  return exhibit.widths ?? APP_FALLBACK_WIDTHS;
}

/** Group exhibits by their id's prefix, preserving first-seen order. */
function groupExhibits(exhibits: readonly Exhibit[]): [string, Exhibit[]][] {
  const groups = new Map<string, Exhibit[]>();
  for (const e of exhibits) {
    const group = exhibitGroupOf(e.id);
    const bucket = groups.get(group);
    if (bucket) bucket.push(e);
    else groups.set(group, [e]);
  }
  return [...groups];
}

/** One exhibit: its label, id and badges, then one card per width. */
function ExhibitEntry({ exhibit }: { exhibit: Exhibit }): ReactElement {
  const runtime = RUNTIME_BADGE[exhibit.runtime];
  // A region is always measured by the layout harness (it supplies the
  // invariants); an isolated exhibit only when it declares geometry.
  const measured =
    exhibit.runtime === "isolated-region" ||
    (exhibit.runtime === "isolated" && exhibit.geometry !== undefined);
  return (
    <Stack gap="sm">
      <Stack direction="row" gap="sm" align="baseline" wrap>
        <Text variant="label">{exhibit.label}</Text>
        <Text variant="caption" tone="muted">
          {exhibit.id}
        </Text>
        <Badge variant={runtime.variant}>{runtime.label}</Badge>
        {measured ? <Badge variant="success">geometry</Badge> : null}
      </Stack>
      {exhibit.description === undefined ? null : (
        <Text variant="caption" tone="muted">
          {exhibit.description}
        </Text>
      )}
      {/*
        The width cells wrap: a row whose widths sum past the pane continues on
        the next line, so every cell is in view (a horizontal scroller hid them
        behind an overlay scrollbar a wheel never reaches). The x-scroll is left
        only for a single cell wider than the pane itself.
      */}
      <Scroll axis="x">
        <Stack direction="row" gap="lg" align="start" wrap>
          {widthsOf(exhibit).map((width) => (
            <Stack key={width} gap="2xs">
              <Text variant="caption" tone="muted">
                {width}px
              </Text>
              {/*
                One cell per (exhibit, width): `ExhibitView` wraps each in its
                own error boundary, so a crashing exhibit costs its cell, never
                the gallery — the one surface where an exhibit is looked at
                must not go dark exactly when there is something to look at.
              */}
              <Card>
                <ExhibitView exhibit={exhibit} width={width} />
              </Card>
            </Stack>
          ))}
        </Stack>
      </Scroll>
    </Stack>
  );
}

/**
 * Debug → Exhibits: every exhibit in the catalog, grouped by id prefix, each
 * rendered at each of its widths. Isolated, region and app exhibits alike —
 * the human-eyeball complement to the layout harness's geometry gate. No
 * measurement here.
 */
export function ExhibitsGallery(): ReactElement {
  const catalog = useExhibits();

  if (catalog.kind === "loading") {
    return (
      <Inset pad="lg">
        <Loading label="Loading exhibits…" />
      </Inset>
    );
  }

  const groups = groupExhibits(catalog.exhibits);

  return (
    <Scroll fill>
      <Inset pad="lg">
        <Stack gap="2xl">
          {groups.length === 0 ? (
            <Text variant="body" tone="muted">
              No exhibits contributed yet.
            </Text>
          ) : (
            groups.map(([group, exhibits]) => (
              <Stack key={group} gap="lg">
                <SectionLabel>{group}</SectionLabel>
                <Stack gap="xl">
                  {exhibits.map((exhibit, i) => (
                    // Index in the key: the catalog is not de-duplicated, so a
                    // clashing id shows twice rather than collapsing.
                    <ExhibitEntry
                      key={`${exhibit.id}#${String(i)}`}
                      exhibit={exhibit}
                    />
                  ))}
                </Stack>
              </Stack>
            ))
          )}
        </Stack>
      </Inset>
    </Scroll>
  );
}
