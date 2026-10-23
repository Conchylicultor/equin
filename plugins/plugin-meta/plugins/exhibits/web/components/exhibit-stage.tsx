import type { ReactElement } from "react";
import type { Exhibit } from "@plugins/plugin-meta/plugins/exhibits/core";
import {
  Pane,
  PaneChrome,
  PaneIconAction,
  defineRoute,
  useOpenPane,
} from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { SurfaceOverlay } from "@plugins/primitives/plugins/overlay/plugins/surface-overlay/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  hoverRevealClass,
  useHoverReveal,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useExhibit } from "../use-exhibits";
import { ExhibitView } from "./exhibit-view";
import { exhibitPane } from "./exhibits-pane";
import { defaultThemeOf, useThemeOptions } from "./exhibit-theme";

// One exhibit, alone on the whole tab: no Debug sidebar, no catalog, no title
// or picker — a screenshot of the tab is a screenshot of the component.
// `;width` lays it out at exactly that many px (absent: the tab's width);
// `;theme` as in the viewer.
export const exhibitStagePane = Pane.define({
  route: defineRoute({
    id: "exhibit-stage",
    segment: "exhibit-stage/:id*;width;theme",
  }),
  app: debugApp,
  title: { useText: ({ id }) => id },
  component: ExhibitStageBody,
  useResolve: false,
});

/** The viewer's header action opening this exhibit, in its theme, full-screen. */
export function OpenFullScreenAction(): ReactElement {
  const { id, theme } = exhibitPane.useParams();
  const openPane = useOpenPane();
  return (
    <PaneIconAction
      label="Open full-screen"
      icon={symbol("fullscreen")}
      {...openPane.link(exhibitStagePane, { id, theme }, { mode: "root" })}
    />
  );
}

/** `;width` as px, or why it is not one. */
function parseWidth(
  raw: string | undefined,
): { ok: true; width: number | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, width: undefined };
  const width = Number(raw);
  return Number.isInteger(width) && width > 0
    ? { ok: true, width }
    : { ok: false };
}

function Stage({
  exhibit,
  width,
  theme,
}: {
  exhibit: Exhibit;
  width: number | undefined;
  theme: string | undefined;
}): ReactElement {
  const value = theme ?? defaultThemeOf(exhibit);
  const picked = useThemeOptions(exhibit).find((o) => o.value === value);
  if (picked === undefined) {
    return (
      <Message>No installed app or fixed theme is called “{value}”.</Message>
    );
  }
  return (
    <Theme name={picked.scope} surface="canvas" className="size-full">
      <Scroll fill axis="both">
        <div data-exhibit-stage="">
          <ExhibitView exhibit={exhibit} width={width} />
        </div>
      </Scroll>
    </Theme>
  );
}

function Message({ children }: { children: string | string[] }): ReactElement {
  return (
    <Inset pad="lg">
      <Text variant="body" tone="muted">
        {children}
      </Text>
    </Inset>
  );
}

function ExhibitStageBody(): ReactElement {
  const { id, width, theme } = exhibitStagePane.useParams();
  const found = useExhibit(id);
  const parsed = parseWidth(width);
  const openPane = useOpenPane();
  const { revealed, groupProps } = useHoverReveal();
  return (
    <PaneChrome pane={exhibitStagePane}>
      <SurfaceOverlay className="bg-background" {...groupProps}>
        {!parsed.ok ? (
          <Message>“{width ?? ""}” is not a width in px.</Message>
        ) : found.kind === "loading" ? (
          <Inset pad="lg">
            <Loading label="Loading exhibit…" />
          </Inset>
        ) : found.kind === "found" ? (
          <Stage exhibit={found.exhibit} width={parsed.width} theme={theme} />
        ) : (
          <Message>
            {found.kind === "missing"
              ? `No exhibit is called “${id}” in this build.`
              : `Several plugins contribute an exhibit called “${id}”.`}
          </Message>
        )}
        {/* The way back, shown only on hover so it is in no screenshot.
            Top-left: solo mode floats the action bar over the top-right. */}
        <Pin to="top-left" offset="sm">
          <IconButton
            className={hoverRevealClass(revealed)}
            icon={symbol("fullscreen-exit")}
            label="Exit full-screen"
            {...openPane.link(exhibitPane, { id, theme }, { mode: "root" })}
          />
        </Pin>
      </SurfaceOverlay>
    </PaneChrome>
  );
}
