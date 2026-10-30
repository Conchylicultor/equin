import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  useEditableField,
  type EditableField,
} from "@plugins/primitives/plugins/editable-field/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type { Server } from "../../shared";
import { updateServer, type UpdateServerBody } from "../../shared/endpoints";
import { FieldShell, fieldInputClass } from "./server-fields";

/** Wire an EditableField to a text input / textarea. */
function fieldProps(field: EditableField<string>) {
  return {
    value: field.value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      field.onChange(e.target.value),
    onFocus: field.onFocus,
    onBlur: field.onBlur,
  };
}

/**
 * The **identity section** of the server detail pane, contributed into
 * `ServerDetail` as a plain section — an identity block is a card like its
 * peers; the pane header is what carries the server's name.
 *
 * Edit state of the unified server page: the same field layout as the create
 * form, but every field autosaves through `updateServer` (the app's standard
 * debounced-autosave + sync-status cloud). Viewing a server is editing it.
 *
 * No padding of its own: the section card supplies the body's inset.
 */
export function ServerEditForm({ server }: { server: Server }) {
  const fetchEndpoint = useFetchEndpoint();
  const save = async (body: UpdateServerBody): Promise<void> => {
    await fetchEndpoint(updateServer, { id: server.id }, { body });
  };

  const name = useEditableField({
    value: server.name,
    label: "Server name",
    onSave: (v) => save({ name: v || server.host }),
  });
  const host = useEditableField({
    value: server.host,
    label: "Host",
    // Host is required — an empty draft reverts to the stored value on blur
    // (the hook mirrors the unchanged server value back) rather than wiping it.
    onSave: (v) => (v ? save({ host: v }) : undefined),
  });
  const sshUser = useEditableField({
    value: server.sshUser,
    label: "SSH user",
    onSave: (v) => save({ sshUser: v || "root" }),
  });
  const port = useEditableField({
    value: String(server.port),
    label: "Port",
    onSave: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? save({ port: n }) : undefined;
    },
  });
  const consoleUrl = useEditableField({
    value: server.consoleUrl ?? "",
    label: "Console URL",
    onSave: (v) => save({ consoleUrl: v || null }),
  });

  return (
    <Stack gap="lg">
      <FieldShell label="Name">
        <input
          className={fieldInputClass}
          placeholder={server.host}
          {...fieldProps(name)}
        />
      </FieldShell>
      <FieldShell label="Host" required>
        <input className={fieldInputClass} {...fieldProps(host)} />
      </FieldShell>
      <Stack direction="row" gap="md">
        {/* FieldShell owns its own element, so the grow cell arrives as a class. */}
        <FieldShell label="SSH User" className={fillClasses("x")}>
          <input className={fieldInputClass} {...fieldProps(sshUser)} />
        </FieldShell>
        <FieldShell label="Port" className="w-20">
          <input
            className={fieldInputClass}
            type="number"
            {...fieldProps(port)}
          />
        </FieldShell>
      </Stack>
      <FieldShell
        label="Console URL"
        hint="Link to the provider's management console for this server."
      >
        <input
          className={fieldInputClass}
          type="url"
          placeholder="e.g. https://console.hetzner.com/projects/…/servers/…"
          {...fieldProps(consoleUrl)}
        />
      </FieldShell>
      {/* Deliberately NO ssh-key field here. Everything SSH-key-shaped lives in
          the `ssh-setup` section next door, which owns the whole flow: two write
          paths for one secret is how the status and the box came to contradict
          each other. */}
    </Stack>
  );
}
