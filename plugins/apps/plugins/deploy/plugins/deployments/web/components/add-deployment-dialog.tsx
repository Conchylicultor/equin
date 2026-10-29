import { useState, type ReactElement, type ReactNode } from "react";
import {
  Button,
  DialogTitle,
  DialogDescription,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  getEndpointErrorMessage,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { useManifestItems } from "@plugins/plugin-meta/plugins/composition/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { servers } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import {
  createDeployment,
  DEFAULT_LOOPBACK_PORT,
  deployments,
  deriveInstall,
} from "../../core";

/** One labelled row of the form. Local, tiny, and not chrome worth a primitive. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <Stack gap="2xs">
      <Text as="label" variant="label">
        {label}
      </Text>
      {children}
      {hint && (
        <Text as="p" variant="caption" tone="muted">
          {hint}
        </Text>
      )}
    </Stack>
  );
}

/**
 * Add a deployment to one server: pick a composition, name the hostnames, pick
 * the loopback port. Those three fields are the whole record — everything about
 * the install (run user, dir layout, systemd unit, Caddy site) is derived from
 * the composition name, which is why the derived preview below is read-only
 * prose rather than more inputs.
 *
 * The composition list comes from `useManifestItems()` — the same hook the
 * Studio compositions pane reads, never `config_v2` directly. Compositions
 * already deployed on the chosen server are omitted: `(composition, server)` is
 * unique, so offering one would only be a way to earn a 409.
 *
 * Opened from a server's page the server is fixed (`serverId`); opened from
 * anywhere else (the sidebar's Sites "+", the sites index) the form starts by
 * picking it.
 */
export function AddDeploymentDialog({
  serverId: fixedServerId,
  close,
}: {
  serverId?: string;
  close: () => void;
}): ReactElement {
  const [pickedServerId, setPickedServerId] = useState("");
  const serverId = fixedServerId ?? pickedServerId;

  const [composition, setComposition] = useState("");
  const [hostnames, setHostnames] = useState("");
  const [port, setPort] = useState(String(DEFAULT_LOOPBACK_PORT));

  // `suppressError` + an inline message: every rejection here names a field on
  // this very form (an unknown composition lists what is known, a malformed
  // hostname says what a hostname must look like, a duplicate or a taken port
  // names the invariant), so it belongs beside the inputs rather than in a toast
  // that outlives the dialog.
  const create = useEndpointMutation(createDeployment, {
    meta: { suppressError: true },
    onSuccess: () => close(),
  });

  const install = composition ? deriveInstall(composition) : null;

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    if (!composition || !serverId) return;
    create.mutate({
      body: {
        compositionId: composition,
        serverId,
        hostnames: parseHostnames(hostnames),
        loopbackPort: Number(port),
      },
    });
  }

  return (
    <Stack as="form" onSubmit={submit} gap="md">
      <Stack gap="xs">
        <DialogTitle>Add a deployment</DialogTitle>
        <DialogDescription>
          Where a composition is served on a server, and under what URL.
        </DialogDescription>
      </Stack>

      {fixedServerId === undefined && (
        <Field label="Server">
          <ServerPicker
            value={pickedServerId}
            onChange={(id) => {
              setPickedServerId(id);
              setComposition("");
            }}
          />
        </Field>
      )}

      {serverId !== "" && (
        <CompositionField
          serverId={serverId}
          value={composition}
          onChange={setComposition}
        />
      )}

      <Field
        label="Hostnames"
        hint="Comma-separated, e.g. equin.ai, www.equin.ai. Leave empty to serve on loopback only — a deployment with no hostname gets no Caddy site and is not internet-reachable."
      >
        <Input
          value={hostnames}
          placeholder="equin.ai"
          onChange={(e) => setHostnames(e.target.value)}
        />
      </Field>

      <Field
        label="Loopback port"
        hint="The port the gateway binds on 127.0.0.1; Caddy proxies to it. Unique per server."
      >
        <Input
          type="number"
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
      </Field>

      {install && (
        <Stack gap="2xs">
          <Text as="p" variant="caption" tone="muted">
            Derived from the composition name — not editable, and not stored:
          </Text>
          <Text as="p" variant="caption" tone="muted">
            <Text as="code" variant="caption">
              {install.installDir}
            </Text>{" "}
            as{" "}
            <Text as="code" variant="caption">
              {install.runUser}
            </Text>
            , unit{" "}
            <Text as="code" variant="caption">
              {install.unit}
            </Text>
          </Text>
        </Stack>
      )}

      {create.isError && (
        <Text as="p" variant="caption" tone="destructive">
          {getEndpointErrorMessage(create.error)}
        </Text>
      )}

      <Stack direction="row" align="center" gap="sm">
        <Fill />
        <Button variant="ghost" type="button" onClick={close}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!composition || !serverId || create.isPending}
          loading={create.isPending}
        >
          Add deployment
        </Button>
      </Stack>
    </Stack>
  );
}

/**
 * The composition choice for one server: every composition not yet deployed
 * there. The server's deployments are read live — which compositions it
 * already serves is a fact about the server, not something the opener hands
 * in — and the choice waits for them rather than offering a 409.
 */
function CompositionField({
  serverId,
  value,
  onChange,
}: {
  serverId: string;
  value: string;
  onChange: (composition: string) => void;
}): ReactElement {
  const items = useManifestItems();
  const existing = useLive(deployments, { where: { serverId } });
  switch (existing.status) {
    case "loading":
      return <Loading variant="rows" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="the server's deployments"
          error={existing.error}
          refetch={existing.refetch}
        />
      );
    case "ready":
      break;
  }
  const taken = new Set(existing.data.map((d) => d.compositionId));
  const available = items.map((i) => i.name).filter((name) => !taken.has(name));
  return (
    <Field
      label="Composition"
      hint={
        available.length === 0
          ? "Every composition already has a deployment on this server."
          : undefined
      }
    >
      <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
        <SelectTrigger>
          <SelectValue placeholder="Pick a composition" />
        </SelectTrigger>
        <SelectContent>
          {available.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Every registered server, by name — the dialog's first choice when unfixed. */
function ServerPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (serverId: string) => void;
}): ReactElement {
  const result = useLive(servers);
  switch (result.status) {
    case "loading":
      return <Loading variant="rows" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="the servers"
          error={result.error}
          refetch={result.refetch}
        />
      );
    case "ready":
      break;
  }
  if (result.data.length === 0) {
    return (
      <Text as="p" variant="caption" tone="muted">
        No servers registered yet — add one first.
      </Text>
    );
  }
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
      <SelectTrigger>
        <SelectValue placeholder="Pick a server" />
      </SelectTrigger>
      <SelectContent>
        {result.data.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Split the hostnames field. Whitespace and commas both separate, because both
 * are what a person types — and the endpoint validates each resulting hostname
 * against a real DNS-label regex, so this only has to break the string up.
 */
function parseHostnames(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter((h) => h !== "");
}
