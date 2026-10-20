import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  Sonata,
  SonataSectionItem,
  SonataSectionStack,
  useSonataSectionOpen,
  type SonataSection,
} from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { Glass } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/glass/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useSectionPaneCollapsed } from "./panels-toggle";
import {
  DOCK_EASE,
  DOCK_MS,
  prefersReducedMotion,
} from "../internal/dock-motion";
import {
  EDGE,
  PANEL_BOTTOM,
  PANEL_TOP,
  PANEL_WIDTH,
  RAIL_BUTTON,
  RAIL_WIDTH,
} from "../internal/player-geometry";

const closeIcon = symbol("close");
const sectionIcon = symbol("view-agenda");

/**
 * The song's sections, docked at the window's right edge — the
 * `Sonata.Section` contributions in two states of ONE dock, so the sections
 * never cover the notes:
 *
 * - **rail** (collapsed): one icon per section, grouped by the dividers of the
 *   slot's order config (`config/apps/sonata/shell/section.jsonc`). Picking one
 *   expands the dock with that section open.
 * - **panel** (expanded): every section's title, each opening and closing on
 *   its own (so any number can be open together), under a "Song" header whose
 *   × folds it back to the rail. (Not Esc: Esc already leaves the solo surface.)
 *
 * The two morph into each other (`useDockMorph`): the panel grows out of the
 * rail's pill and shrinks back into it, while the notes' edge eases on the
 * same clock (`DOCK_MS`). The rail stays mounted under the open panel —
 * hidden and inert — so there is always a pill to grow from and fold into.
 *
 * Collapsed or not is one device-local choice (`useSectionPaneCollapsed`); each
 * section's open state is its card's own persisted value, which the rail writes
 * through `useSonataSectionOpen` — so the rail and the cards cannot disagree.
 */
export function SectionDock() {
  const [collapsed] = useSectionPaneCollapsed();
  const railRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelShown = useDockMorph(collapsed, railRef, panelRef);
  return (
    <>
      {/* Fades out as the panel grows over it, and back in as the panel lands
          on it. */}
      <Placed
        ref={railRef}
        x={{ end: EDGE, size: RAIL_WIDTH }}
        y={{ center: "50%" }}
        layer="float"
        inert={!collapsed}
        className={cn(
          "transition-opacity motion-reduce:transition-none",
          collapsed
            ? "opacity-100 delay-150 duration-250"
            : "opacity-0 duration-150",
        )}
      >
        <SectionRail />
      </Placed>
      {panelShown && (
        <Placed
          ref={panelRef}
          x={{ end: EDGE, size: PANEL_WIDTH }}
          y={{ start: PANEL_TOP, end: PANEL_BOTTOM }}
          layer="float"
        >
          <SectionPanel />
        </Placed>
      )}
    </>
  );
}

/**
 * Morphs the panel out of the rail and back: its clip runs between the rail's
 * pill (measured, so a rail of any height fits) and the whole panel, fading
 * in. Returns whether the panel is mounted — past the collapse, while it
 * shrinks back into the rail. A toggle mid-morph reverses the running morph
 * from where it stands. Under `prefers-reduced-motion` the states just swap.
 */
function useDockMorph(
  collapsed: boolean,
  railRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
): boolean {
  // The panel outlives a collapse until its shrink lands (adjusted during
  // render, React's way of deriving state from a changed prop).
  const [lingering, setLingering] = useState(false);
  const [prevCollapsed, setPrevCollapsed] = useState(collapsed);
  if (prevCollapsed !== collapsed) {
    setPrevCollapsed(collapsed);
    setLingering(collapsed && !prefersReducedMotion());
  }
  const running = useRef<Animation | null>(null);
  // The state the dock is at or heading to; the first paint does not morph.
  const target = useRef(!collapsed);

  useLayoutEffect(() => {
    const expand = !collapsed;
    if (target.current === expand) return;
    target.current = expand;
    const current = running.current;
    if (current) {
      current.reverse();
      return;
    }
    const panel = panelRef.current;
    const rail = railRef.current;
    if (!panel || !rail || prefersReducedMotion()) return;
    const p = panel.getBoundingClientRect();
    const r = rail.getBoundingClientRect();
    const pill = {
      clipPath: `inset(${r.top - p.top}px ${p.right - r.right}px ${p.bottom - r.bottom}px ${r.left - p.left}px round ${r.width / 2}px)`,
      opacity: 0,
    };
    const whole = { clipPath: "inset(0 0 0 0 round 22px)", opacity: 1 };
    // The panel stays opaque for all but the stretch nearest the pill (the
    // eased progress races ahead, so a linear fade would lose it early), where
    // it hands over to the rail fading in under it.
    const opaque = { offset: expand ? 0.15 : 0.85, opacity: 1 };
    const morph = panel.animate(
      expand ? [pill, opaque, whole] : [whole, opaque, pill],
      {
        duration: DOCK_MS,
        easing: DOCK_EASE,
        fill: "both",
      },
    );
    running.current = morph;
    morph.onfinish = () => {
      running.current = null;
      // Landed expanded (forward grow, or a shrink reversed): drop the clip,
      // which would otherwise cut the panel's shadow. Landed on the rail:
      // unmount, the clip held until then.
      if (expand === morph.playbackRate > 0) morph.cancel();
      else setLingering(false);
    };
  }, [collapsed, panelRef, railRef]);

  useLayoutEffect(() => () => running.current?.cancel(), []);

  return !collapsed || lingering;
}

/**
 * The rail's icon buttons are the mockup's 40px, a size past the density's
 * largest control (`lg`): the rail re-states `lg` for itself, so its buttons
 * still size from the ambient density and stay squares like every other.
 */
const railControlSize = {
  "--control-height-lg": `${RAIL_BUTTON}px`,
} as CSSProperties;

/** The collapsed dock: a glass column of section icons. */
function SectionRail() {
  return (
    <Glass className="py-xs">
      {/* One centred column of icons. The order config's dividers are this
          rail's group rules: short (`rail-x-none` takes the divider's inline
          inset off, so the rule spans its own 18px) and centred, as the mockup
          draws them. */}
      <Stack
        gap="2xs"
        align="center"
        className="rail-x-none [&>[role=separator]]:w-4.5"
        style={railControlSize}
      >
        <Sonata.Section.Render controlSize="lg">
          {(s) => <RailItem key={s.id} section={s} />}
        </Sonata.Section.Render>
      </Stack>
    </Glass>
  );
}

/** One rail icon — painted only when its section has something to show. */
function RailItem({ section }: { section: SonataSection & { id: string } }) {
  if (section.useAvailable) {
    return (
      <AvailableRailItem
        useAvailable={section.useAvailable}
        section={section}
      />
    );
  }
  return <RailButton section={section} />;
}

function AvailableRailItem({
  useAvailable,
  section,
}: {
  useAvailable: NonNullable<SonataSection["useAvailable"]>;
  section: SonataSection & { id: string };
}) {
  return useAvailable({}) ? <RailButton section={section} /> : null;
}

function RailButton({ section }: { section: SonataSection & { id: string } }) {
  const [, setOpen] = useSonataSectionOpen(section.id);
  const [, setCollapsed] = useSectionPaneCollapsed();
  return (
    <IconButton
      icon={section.icon ?? sectionIcon}
      label={section.label}
      tooltipSide="left"
      onClick={() => {
        // A section with a body opens; a one-line section has nothing to open
        // and simply shows in the panel.
        if (section.component) setOpen(true);
        setCollapsed(false);
      }}
    />
  );
}

/** The expanded dock: every section's title, the open ones with their body. */
function SectionPanel() {
  const [, setCollapsed] = useSectionPaneCollapsed();
  return (
    <Glass shape="panel" className="h-full">
      <Column
        fill
        className="h-full"
        header={
          <Line className="gap-sm border-b border-border py-sm pr-xs pl-lg">
            <Fill>
              <Text variant="subheading" className="font-bold">
                Song
              </Text>
            </Fill>
            <ControlSizeProvider size="lg">
              <IconButton
                icon={closeIcon}
                label="Collapse to the rail"
                onClick={() => setCollapsed(true)}
              />
            </ControlSizeProvider>
          </Line>
        }
        body={
          // The order config's dividers group the RAIL; in the panel every
          // section is already closed by its own rule.
          <div className="[&_[role=separator]]:hidden">
            <SonataSectionStack>
              <Sonata.Section.Render subId="editor">
                {(s) =>
                  s.area === "editor" ? (
                    <SonataSectionItem section={s} entityProps={{}} />
                  ) : null
                }
              </Sonata.Section.Render>
              <Sonata.Section.Render subId="player">
                {(s) =>
                  s.area !== "editor" ? (
                    <SonataSectionItem section={s} entityProps={{}} />
                  ) : null
                }
              </Sonata.Section.Render>
            </SonataSectionStack>
          </div>
        }
      />
    </Glass>
  );
}
