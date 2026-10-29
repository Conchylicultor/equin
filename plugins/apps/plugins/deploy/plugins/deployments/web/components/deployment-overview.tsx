import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import type { ReactNode } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import { useEditableField } from "@plugins/primitives/plugins/editable-field/web";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { servers } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  deployments,
  deriveInstall,
  updateDeployment,
  type Deployment,
  type UpdateDeploymentBody,
} from "../../core";

const serverIcon = symbol("dns");

/**
 * Reads the site's row, then renders `body` with it — the one loading / error /
 * gone fold every Settings section of this plugin shares.
 */
export function WithDeployment({
  deploymentId,
  body: Body,
}: {
  deploymentId: string;
  body: (props: { deployment: Deployment }) => ReactNode;
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
  return <Body deployment={deployment.row} />;
}

/**
 * One Settings row: the label (with an optional hint under it) in a fixed
 * column, the value beside it.
 */
export function SettingsField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <Stack direction="row" align="center" gap="md">
      <Rigid className="w-44">
        <Stack gap="none">
          <Text as="span" variant="body" tone="muted">
            {label}
          </Text>
          {hint && (
            <Text as="span" variant="caption" tone="faint">
              {hint}
            </Text>
          )}
        </Stack>
      </Rigid>
      <Fill>{children}</Fill>
    </Stack>
  );
}

/** Settings → General: the record's editable fields and the server it is on. */
export function DeploymentGeneral({
  deploymentId,
}: {
  deploymentId: string;
}): ReactNode {
  return <WithDeployment deploymentId={deploymentId} body={GeneralBody} />;
}

function GeneralBody({ deployment }: { deployment: Deployment }): ReactNode {
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

  return (
    <Stack gap="md">
      <SettingsField
        label="Hostnames"
        hint="Comma-separated; Caddy serves and certifies each"
      >
        <Input
          value={hostnames.value}
          onChange={(e) => hostnames.onChange(e.target.value)}
          onFocus={hostnames.onFocus}
          onBlur={hostnames.onBlur}
          placeholder="app.example.com, *.example.com"
        />
      </SettingsField>
      <SettingsField label="Loopback port" hint="Unique on this server">
        <Input
          type="number"
          className="max-w-32 font-mono"
          value={loopbackPort.value}
          onChange={(e) => loopbackPort.onChange(e.target.value)}
          onFocus={loopbackPort.onFocus}
          onBlur={loopbackPort.onBlur}
        />
      </SettingsField>
      <SettingsField label="Server">
        <ServerName serverId={deployment.serverId} />
      </SettingsField>
    </Stack>
  );
}

/** The server a site is on — its name and address, from the registry. */
export function ServerName({ serverId }: { serverId: string }): ReactNode {
  const list = useLive(servers);
  if (list.status === "loading") return <Loading />;
  if (list.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the server"
        error={list.error}
        refetch={list.refetch}
      />
    );
  }
  const server = list.data.find((s) => s.id === serverId);
  return (
    <Inline gap="xs">
      <Icon icon={serverIcon} />
      <Text as="span" variant="body">
        {server?.name ?? serverId}
      </Text>
      {server && (
        <Text as="span" variant="code" tone="faint">
          {server.host}
        </Text>
      )}
    </Inline>
  );
}

/**
 * Settings → Install: the install the composition name implies. None of these
 * is a value anyone gets to choose — `runUser` in particular exists only to be
 * non-root, and a field with a default is a field someone can set back to
 * `root`. They are shown (and copyable), never edited.
 */
export function DeploymentInstall({
  deploymentId,
}: {
  deploymentId: string;
}): ReactNode {
  return <WithDeployment deploymentId={deploymentId} body={InstallBody} />;
}

function InstallBody({ deployment }: { deployment: Deployment }): ReactNode {
  const install = deriveInstall(deployment.compositionId);
  return (
    <Stack gap="sm">
      <DerivedValue label="Run user" value={install.runUser} />
      <DerivedValue label="Install dir" value={install.installDir} />
      <DerivedValue label="systemd unit" value={install.unit} />
      <DerivedValue label="Caddy site" value={install.caddySitePath} />
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
    <SettingsField label={label}>
      <Inline gap="xs">
        <Text as="code" variant="code" tone="muted" className="break-all">
          {value}
        </Text>
        <CopyButton text={value} tooltip={`Copy ${label.toLowerCase()}`} />
      </Inline>
    </SettingsField>
  );
}
