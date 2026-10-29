import type { ReactNode } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { deleteDeployment, type Deployment } from "../../core";
import { sitesIndexPane } from "../panes";
import { DeploymentDetail } from "../slots";
import { SettingsField, WithDeployment } from "./deployment-overview";
import { DeleteDeploymentDialog } from "./delete-deployment-dialog";

const deleteIcon = symbol("delete");

type SectionProps = { deploymentId: string };

/**
 * The Settings tab: the `DeploymentDetail` sections, with a left rail naming
 * each one — a click opens it and scrolls it into view (`useRevealSection`).
 * A section whose gate says it does not apply (no secrets) is absent from the
 * rail exactly as from the stack.
 */
export function SiteSettingsTab({ deploymentId }: SectionProps): ReactNode {
  return (
    <Stack direction="row" align="start" gap="xl">
      <Rigid className="w-48">
        <Sticky edge="top">
          <Stack gap="2xs" align="start">
            <DeploymentDetail.Section.Render>
              {(section) => (
                <NavEntry section={section} deploymentId={deploymentId} />
              )}
            </DeploymentDetail.Section.Render>
          </Stack>
        </Sticky>
      </Rigid>
      <Fill>
        <DeploymentDetail.Host deploymentId={deploymentId} />
      </Fill>
    </Stack>
  );
}

/** What the rail reads of a section: its id, its title and its gate. */
interface Section {
  id: string;
  label: string;
  useAvailable?: Hook<(props: SectionProps) => boolean>;
}

function NavEntry({
  section,
  deploymentId,
}: {
  section: Section;
  deploymentId: string;
}): ReactNode {
  if (section.useAvailable) {
    return (
      <GatedNavEntry
        section={section}
        useAvailable={section.useAvailable}
        deploymentId={deploymentId}
      />
    );
  }
  return <NavButton section={section} />;
}

function GatedNavEntry({
  section,
  useAvailable,
  deploymentId,
}: {
  section: Section;
  useAvailable: NonNullable<Section["useAvailable"]>;
  deploymentId: string;
}): ReactNode {
  return useAvailable({ deploymentId }) ? (
    <NavButton section={section} />
  ) : null;
}

function NavButton({ section }: { section: Section }): ReactNode {
  const reveal = DeploymentDetail.useRevealSection();
  return (
    <Button
      variant="ghost"
      className="text-muted-foreground"
      onClick={() => reveal(section.id)}
    >
      {section.label}
    </Button>
  );
}

/**
 * Settings → Danger zone: remove the site. The record is forgotten; the install
 * on the server is left running (the dialog says so, naming what remains).
 */
export function DangerZone({ deploymentId }: SectionProps): ReactNode {
  return <WithDeployment deploymentId={deploymentId} body={DangerZoneBody} />;
}

function DangerZoneBody({ deployment }: { deployment: Deployment }): ReactNode {
  // Predicted: the site leaves every read at once, so the dialog closes and
  // the index opens with it; a refusal is the rejection toast.
  const remove = useLiveMutation(deleteDeployment);
  const openPane = useOpenPane();
  const name = deployment.hostnames[0] ?? deployment.compositionId;
  return (
    <SettingsField
      label="Remove site"
      hint="Forgets the record; the server keeps the install"
    >
      <Button
        variant="outline"
        className="text-destructive"
        onClick={() => {
          // Fire-and-forget: returning the openDialog promise would pend the
          // button for the dialog's whole open lifetime rather than the delete's.
          void openDialog(
            (close) => (
              <DeleteDeploymentDialog
                deployment={deployment}
                onCancel={close}
                onConfirm={() => {
                  remove.mutate({ params: { id: deployment.id } });
                  close();
                  openPane(sitesIndexPane, {}, { mode: "root" });
                }}
              />
            ),
            { size: "sm" },
          );
        }}
      >
        <Icon icon={deleteIcon} />
        Remove {name}
      </Button>
    </SettingsField>
  );
}
