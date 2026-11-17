import { useState } from "react";
import {
  useEndpointMutation,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Input,
  Textarea,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { transient } from "@plugins/primitives/plugins/kept-state/core";
import {
  defineKept,
  useKept,
} from "@plugins/primitives/plugins/kept-state/web";
import { z } from "zod";
import { createServer } from "../../shared/endpoints";
import {
  FieldShell,
  fieldInputClass,
  fieldTextareaClass,
} from "./server-fields";

/** The new server's text fields, one entry per field (subject `new|<field>`). */
const newServerDraft = defineKept({
  owner: "deploy.servers.new-server",
  label: "New server drafts",
  tier: "work",
  stamp: "nl1v68s27p",
  cap: "8 KB",
  schema: z.string(),
});

/**
 * Create state of the unified server page: blank fields + an explicit "Add
 * Server" button (a row can't autosave until it exists). Renders the same
 * field layout as the edit form, so adding and editing look identical.
 */
export function ServerCreateForm({
  onCreated,
}: {
  onCreated: (id: string) => void;
}) {
  const nameKept = useKept(newServerDraft, "", { subject: "new|name" });
  const hostKept = useKept(newServerDraft, "", { subject: "new|host" });
  const sshUserKept = useKept(newServerDraft, "root", {
    subject: "new|ssh-user",
  });
  const consoleUrlKept = useKept(newServerDraft, "", {
    subject: "new|console-url",
  });
  const [name] = nameKept;
  const [host] = hostKept;
  const [sshUser] = sshUserKept;
  const [consoleUrl] = consoleUrlKept;
  const [port, setPort] = useState("22");
  const [sshPrivateKey, setSshPrivateKey] = useState("");

  // The key goes through the same validating import path as the server page's
  // paste, so an unusable key is a 400 with copy naming the actual mistake.
  // Rendered inline: the offending field is right here on the form, and this
  // submit is the user's only way to act on it.
  const create = useEndpointMutation(createServer, {
    meta: { suppressError: true },
    onSuccess: (server) => {
      for (const kept of [nameKept, hostKept, sshUserKept, consoleUrlKept])
        kept[2]();
      onCreated(server.id);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!host) return;
    create.mutate({
      body: {
        name: name || host,
        host,
        port: Number(port) || 22,
        sshUser: sshUser || "root",
        consoleUrl: consoleUrl || undefined,
        sshPrivateKey: sshPrivateKey || undefined,
      },
    });
  }

  return (
    <Stack as="form" onSubmit={handleSubmit} gap="lg">
      <FieldShell label="Name">
        <Input
          bare
          keep={nameKept}
          className={fieldInputClass}
          placeholder="e.g. equin-prod"
        />
      </FieldShell>
      <FieldShell label="Host" required>
        <Input
          bare
          keep={hostKept}
          className={fieldInputClass}
          placeholder="e.g. 49.13.197.105"
          required
          autoFocus
        />
      </FieldShell>
      <Stack direction="row" gap="md">
        {/* FieldShell owns its own element, so the grow cell arrives as a class. */}
        <FieldShell label="SSH User" className={fillClasses("x")}>
          <Input bare keep={sshUserKept} className={fieldInputClass} />
        </FieldShell>
        <FieldShell label="Port" className="w-20">
          <input
            className={fieldInputClass}
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </FieldShell>
      </Stack>
      <FieldShell
        label="Console URL"
        hint="Link to the provider's management console for this server."
      >
        <Input
          bare
          keep={consoleUrlKept}
          className={fieldInputClass}
          type="url"
          placeholder="e.g. https://console.hetzner.com/projects/…/servers/…"
        />
      </FieldShell>
      <FieldShell
        label="SSH Private Key"
        hint="Optional. Must have no passphrase. You can also generate one after adding the server."
      >
        <Textarea
          bare
          keep={transient("secret: never written to browser storage")}
          className={fieldTextareaClass}
          rows={5}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          value={sshPrivateKey}
          onChange={(e) => setSshPrivateKey(e.target.value)}
        />
      </FieldShell>
      {create.isError && (
        <Text as="p" variant="caption" tone="destructive">
          {getEndpointErrorMessage(create.error)}
        </Text>
      )}
      <Stack gap="none" direction="row" justify="end" className="pt-xs">
        <button
          type="submit"
          disabled={!host || create.isPending}
          className="bg-primary text-primary-foreground rounded-md px-md py-xs text-label disabled:opacity-50"
        >
          {create.isPending ? "Adding…" : "Add Server"}
        </button>
      </Stack>
    </Stack>
  );
}
