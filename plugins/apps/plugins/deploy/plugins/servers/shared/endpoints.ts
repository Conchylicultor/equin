import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { ServerSchema } from "./schemas";

export const CreateServerBodySchema = z.object({
  name: z.string().optional(),
  host: z.string(),
  port: z.number().optional(),
  sshUser: z.string().optional(),
  consoleUrl: z.string().optional(),
  sshPrivateKey: z.string().optional(),
});
export type CreateServerBody = z.infer<typeof CreateServerBodySchema>;

/**
 * Deliberately has no `sshPrivateKey`: this is the autosave PATCH behind every
 * field edit, and a key write is a validating, destructive operation that needs
 * somewhere to report a 400. It goes through `importSshPrivateKey` instead.
 */
export const UpdateServerBodySchema = z.object({
  name: z.string().optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  sshUser: z.string().optional(),
  consoleUrl: z.string().nullable().optional(),
});
export type UpdateServerBody = z.infer<typeof UpdateServerBodySchema>;

export const listServers = defineEndpoint({
  route: "GET /api/deploy/servers",
  response: z.array(ServerSchema),
});

export const createServer = defineEndpoint({
  route: "POST /api/deploy/servers",
  body: CreateServerBodySchema,
  response: ServerSchema,
});

export const getServer = defineEndpoint({
  route: "GET /api/deploy/servers/:id",
  response: ServerSchema,
});

export const updateServer = defineEndpoint({
  route: "PATCH /api/deploy/servers/:id",
  body: UpdateServerBodySchema,
  response: ServerSchema,
});

export const deleteServer = defineEndpoint({
  route: "DELETE /api/deploy/servers/:id",
});

export const GenerateKeypairBodySchema = z.object({
  /** Required to regenerate over an already-configured key (otherwise 409). */
  replace: z.boolean().optional(),
});
export type GenerateKeypairBody = z.infer<typeof GenerateKeypairBodySchema>;

/**
 * Generates an ed25519 keypair for the server: the private half goes straight
 * into the secrets store (never returned), the public half is persisted on the
 * row. Returns the whole server so the caller has the new fingerprint without
 * waiting on the live-state push.
 */
export const generateSshKeypair = defineEndpoint({
  route: "POST /api/deploy/servers/:id/ssh-keypair",
  body: GenerateKeypairBodySchema,
  response: ServerSchema,
});

export const ImportKeypairBodySchema = z.object({
  /** An OpenSSH private key with no passphrase. Its public half is derived. */
  privateKey: z.string(),
  /** Required to overwrite an already-configured key (otherwise 409). */
  replace: z.boolean().optional(),
});
export type ImportKeypairBody = z.infer<typeof ImportKeypairBodySchema>;

/**
 * Adopts a private key the user already has: `ssh-keygen -y` derives the public
 * half so the row never holds a key we can't identify, and an unusable key
 * (public half pasted, passphrase-protected, not a key) is a 400 with copy that
 * names the actual mistake rather than a silent "success".
 */
export const importSshPrivateKey = defineEndpoint({
  route: "POST /api/deploy/servers/:id/ssh-keypair/import",
  body: ImportKeypairBodySchema,
  response: ServerSchema,
});
