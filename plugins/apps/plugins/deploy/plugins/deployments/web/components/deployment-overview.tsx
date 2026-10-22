import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import type { ReactNode } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { useEditableField } from "@plugins/primitives/plugins/editable-field/web";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  deployments,
  deriveInstall,
  updateDeployment,
  type Deployment,
  type UpdateDeploymentBody,
} from "../../core";

/**
 * The deployment record and the install it implies.
 *
 * This content used to be four read-only columns and two editable ones crowding
 * the list row. Moving it here is what let the row become what a person actually
 * scans — composition, last run, release state — while the URL, the port and the
 * whole derived install stay one click away rather than gone.
 */
export function DeploymentOverview({
  deploymentId,
}: {
  deploymentId: string;
}): ReactNode {
  const deployment = useLiveRow(deployments, deploymentId);
  if (deployment.status === "loading") return <Loading variant="rows" />;
  if (deployment.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the deployment"
        error={deployment.error}
        refetch={deployment.refetch}
      />
    );
  }
  if (!deployment.found) {
    return (
      <Placeholder tone="error">This deployment no longer exists.</Placeholder>
    );
  }
  return <OverviewBody deployment={deployment.row} />;
}

function OverviewBody({ deployment }: { deployment: Deployment }): ReactNode {
  const fetchEndpoint = useFetchEndpoint();
  const save = async (body: UpdateDeploymentBody): Promise<void> => {
    await fetchEndpoint(updateDeployment, { id: deployment.id }, { body });
  };

  // Comma-separated rather than a tag editor: the endpoint validates each name
  // against a DNS-label regex and 400s the one that is wrong, so the text form
  // is the honest one — you see exactly the list Caddy will serve.
  const hostnames = useEditableField({
    value: deployment.hostnames.join(", "),
    label: "Hostnames",
    onSave: (v) =>
      save({
        hostnames: v
          .split(",")
          .map((h) => h.trim())
          .filter((h) => h.length > 0),
      }),
  });

  // A non-numeric or out-of-range draft reverts on blur (the hook mirrors the
  // stored value back) rather than sending a value the endpoint would refuse.
  const loopbackPort = useEditableField({
    value: String(deployment.loopbackPort),
    label: "Loopback port",
    onSave: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1024 && n <= 65535
        ? save({ loopbackPort: n })
        : undefined;
    },
  });

  const install = deriveInstall(deployment.compositionId);

  return (
    <Stack gap="lg">
      <Stack gap="2xs">
        <Text as="label" variant="caption" tone="muted">
          Hostnames
        </Text>
        <Input
          value={hostnames.value}
          onChange={(e) => hostnames.onChange(e.target.value)}
          onFocus={hostnames.onFocus}
          onBlur={hostnames.onBlur}
          placeholder="app.example.com, *.example.com"
        />
        <Text as="p" variant="caption" tone="muted">
          Comma-separated. Caddy serves these; converge writes them into this
          install&apos;s site file.
        </Text>
      </Stack>

      <Stack gap="2xs">
        <Text as="label" variant="caption" tone="muted">
          Loopback port
        </Text>
        <Input
          type="number"
          value={loopbackPort.value}
          onChange={(e) => loopbackPort.onChange(e.target.value)}
          onFocus={loopbackPort.onFocus}
          onBlur={loopbackPort.onBlur}
        />
      </Stack>

      {/* ── Derived. None of these is a value anyone gets to choose: `runUser` in
          particular exists only to be non-root, and a field with a default is a
          field someone can set back to `root`. They are shown, never edited. */}
      <Stack gap="sm">
        <Text as="h3" variant="label" tone="muted">
          Install (derived from the composition name)
        </Text>
        <DerivedValue label="Run user" value={install.runUser} />
        <DerivedValue label="Install dir" value={install.installDir} />
        <DerivedValue label="systemd unit" value={install.unit} />
        <DerivedValue label="Caddy site" value={install.caddySitePath} />
      </Stack>
    </Stack>
  );
}

function DerivedValue({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactNode {
  return (
    <Stack gap="2xs">
      <Text as="span" variant="caption" tone="muted">
        {label}
      </Text>
      <Text as="code" variant="caption" className="break-all">
        {value}
      </Text>
    </Stack>
  );
}
