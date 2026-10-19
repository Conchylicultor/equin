import {
  Sonata,
  SonataSectionItem,
  SonataSectionStack,
  useSonataSectionOpen,
  type SonataSection,
} from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { Glass } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/glass/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useSectionPaneCollapsed } from "./panels-toggle";

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
 * Collapsed or not is one device-local choice (`useSectionPaneCollapsed`); each
 * section's open state is its card's own persisted value, which the rail writes
 * through `useSonataSectionOpen` — so the rail and the cards cannot disagree.
 */
export function SectionDock() {
  const [collapsed] = useSectionPaneCollapsed();
  return collapsed ? <SectionRail /> : <SectionPanel />;
}

/** The collapsed dock: a glass column of section icons. */
function SectionRail() {
  return (
    <Glass className="p-2xs">
      {/* The order config's dividers are this rail's group rules: short and
          centred, as the mockup draws them. */}
      <Stack
        gap="2xs"
        className="[&_[role=separator]]:mx-auto [&_[role=separator]]:w-4.5"
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
